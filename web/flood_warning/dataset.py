"""Sliding-window dataset for the hourly CNN.

Each sample:
  past:   (3, 24)  channels [flow_m3s, precip_mm, temp_c] for hours t-24..t-1
  future: (1, 12)  channel  [precip_mm]                    for hours t..t+11
  target: (12,)    flow_m3s                                 for hours t..t+11

Normalization: log1p on flow + precip (right-skewed), z-score everything.
Normalization stats are computed on the training split only.
"""
from __future__ import annotations

import json
from pathlib import Path
from dataclasses import dataclass

import numpy as np
import pandas as pd
import torch
from torch.utils.data import Dataset, DataLoader

from .fetch import DATA_DIR


PAST_STEPS = 24
FUTURE_STEPS = 12


@dataclass
class Scaler:
    """Per-feature normalization stats. Stored alongside model checkpoints."""
    flow_log_mean: float; flow_log_std: float
    precip_log_mean: float; precip_log_std: float
    temp_mean: float; temp_std: float

    def to_dict(self):
        return self.__dict__

    @classmethod
    def from_dict(cls, d):
        return cls(**d)

    def encode_flow(self, x):
        return (np.log1p(np.clip(x, 0, None)) - self.flow_log_mean) / self.flow_log_std
    def decode_flow(self, z):
        return np.expm1(z * self.flow_log_std + self.flow_log_mean)
    def encode_precip(self, x):
        return (np.log1p(np.clip(x, 0, None)) - self.precip_log_mean) / self.precip_log_std
    def encode_temp(self, x):
        return (x - self.temp_mean) / self.temp_std


def build_windows(df: pd.DataFrame, scaler: Scaler | None = None
                  ) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[pd.Timestamp]]:
    """Slide a 24+12 window across the hourly DataFrame, dropping any window
    with missing flow or precip values. Returns (past, future, target, target_t0).
    """
    flow = df['flow_m3s'].values
    precip = df['precip_mm'].fillna(0).values
    temp = df['temp_c'].fillna(temp_mean := np.nanmean(df['temp_c'])).values
    idx = df.index

    n = len(df)
    win = PAST_STEPS + FUTURE_STEPS
    if n < win:
        return (np.zeros((0, 3, PAST_STEPS)), np.zeros((0, 1, FUTURE_STEPS)),
                np.zeros((0, FUTURE_STEPS)), [])

    past_list, fut_list, tgt_list, t0_list = [], [], [], []
    for i in range(n - win + 1):
        f = flow[i:i + win]
        if np.isnan(f).any():
            continue
        p_past = precip[i:i + PAST_STEPS]
        p_fut = precip[i + PAST_STEPS:i + PAST_STEPS + FUTURE_STEPS]
        t_past = temp[i:i + PAST_STEPS]
        flow_past = flow[i:i + PAST_STEPS]
        flow_fut = flow[i + PAST_STEPS:i + PAST_STEPS + FUTURE_STEPS]

        if scaler is not None:
            flow_past = scaler.encode_flow(flow_past)
            flow_fut_scaled = scaler.encode_flow(flow_fut)
            p_past = scaler.encode_precip(p_past)
            p_fut = scaler.encode_precip(p_fut)
            t_past = scaler.encode_temp(t_past)
        else:
            flow_fut_scaled = flow_fut

        past_list.append(np.stack([flow_past, p_past, t_past], axis=0))
        fut_list.append(p_fut[None, :])
        tgt_list.append(flow_fut_scaled)
        t0_list.append(idx[i + PAST_STEPS])

    if not past_list:
        return (np.zeros((0, 3, PAST_STEPS)), np.zeros((0, 1, FUTURE_STEPS)),
                np.zeros((0, FUTURE_STEPS)), [])
    return (np.stack(past_list).astype(np.float32),
            np.stack(fut_list).astype(np.float32),
            np.stack(tgt_list).astype(np.float32),
            t0_list)


def fit_scaler(df: pd.DataFrame) -> Scaler:
    """Compute log/z-score stats on the train portion of one gauge's record."""
    flow = df['flow_m3s'].dropna().values
    precip = df['precip_mm'].dropna().values
    temp = df['temp_c'].dropna().values
    flow_log = np.log1p(np.clip(flow, 0, None))
    precip_log = np.log1p(np.clip(precip, 0, None))
    return Scaler(
        flow_log_mean=float(flow_log.mean()), flow_log_std=float(flow_log.std() + 1e-9),
        precip_log_mean=float(precip_log.mean()), precip_log_std=float(precip_log.std() + 1e-9),
        temp_mean=float(temp.mean()), temp_std=float(temp.std() + 1e-9),
    )


class WindowDataset(Dataset):
    def __init__(self, past, future, target):
        self.past = torch.from_numpy(past)
        self.future = torch.from_numpy(future)
        self.target = torch.from_numpy(target)

    def __len__(self): return len(self.past)
    def __getitem__(self, i):
        return self.past[i], self.future[i], self.target[i]


def load_site_windows(gauge_id: str, train_frac: float = 0.70,
                      val_frac: float = 0.15
                      ) -> tuple[WindowDataset, WindowDataset, WindowDataset,
                                 Scaler, list]:
    """Load a gauge's hourly parquet, split temporally, build windows."""
    df = pd.read_parquet(DATA_DIR / gauge_id / 'hourly.parquet').sort_index()
    n = len(df)
    n_train = int(n * train_frac)
    n_val = int(n * val_frac)
    train_df = df.iloc[:n_train]
    val_df = df.iloc[n_train:n_train + n_val]
    test_df = df.iloc[n_train + n_val:]

    scaler = fit_scaler(train_df.dropna(subset=['flow_m3s']))

    train = WindowDataset(*build_windows(train_df, scaler)[:3])
    val = WindowDataset(*build_windows(val_df, scaler)[:3])
    test_p, test_f, test_t, test_t0 = build_windows(test_df, scaler)
    test = WindowDataset(test_p, test_f, test_t)
    return train, val, test, scaler, test_t0
