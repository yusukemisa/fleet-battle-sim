"""Train the local Decision Transformer and write src/brain/weights/dt.json.

    python3 tools/dt/train.py tools/dt/data/trajectories.jsonl
    python3 tools/dt/train.py --init

The forward pass matches src/brain/dt.ts: pre-norm causal transformer, tanh GELU,
LayerNorm with eps 1e-5. No dropout in the exported weights.
"""
import json
import math
import sys
from pathlib import Path

import torch
from torch import nn

OBS = 99
SLOTS = 5
TACTICS = 8
ACT = SLOTS * TACTICS
D = 96
HEADS = 4
LAYERS = 4
FF = 192
EMBED = 1 + OBS + ACT
CONTEXT = 16
TARGET = 1.2
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'src' / 'brain' / 'weights' / 'dt.json'


def gelu(x: torch.Tensor) -> torch.Tensor:
    inner = math.sqrt(2 / math.pi) * (x + 0.044715 * x * x * x)
    return 0.5 * x * (1 + torch.tanh(inner))


class Block(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.ln1 = nn.LayerNorm(D, eps=1e-5)
        self.wq = nn.Linear(D, D)
        self.wk = nn.Linear(D, D)
        self.wv = nn.Linear(D, D)
        self.wo = nn.Linear(D, D)
        self.ln2 = nn.LayerNorm(D, eps=1e-5)
        self.fc1 = nn.Linear(D, FF)
        self.fc2 = nn.Linear(FF, D)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        h = self.ln1(x)
        q = self.wq(h)
        k = self.wk(h)
        v = self.wv(h)
        b, t, _ = q.shape
        span = D // HEADS
        q = q.view(b, t, HEADS, span).transpose(1, 2)
        k = k.view(b, t, HEADS, span).transpose(1, 2)
        v = v.view(b, t, HEADS, span).transpose(1, 2)
        scores = torch.matmul(q, k.transpose(-2, -1)) / math.sqrt(span)
        causal = torch.tril(torch.ones(t, t, device=x.device))
        scores = scores.masked_fill(causal.view(1, 1, t, t) == 0, -1e9)
        weights = torch.softmax(scores, dim=-1)
        mixed = torch.matmul(weights, v).transpose(1, 2).contiguous().view(b, t, D)
        x = x + self.wo(mixed)
        hidden = gelu(self.fc1(self.ln2(x)))
        return x + self.fc2(hidden)


class DecisionTransformer(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.embed = nn.Linear(EMBED, D)
        self.pos = nn.Parameter(torch.zeros(CONTEXT, D))
        self.blocks = nn.ModuleList(Block() for _ in range(LAYERS))
        self.head = nn.Linear(D, ACT)

    def tokens(self, rtg: torch.Tensor, obs: torch.Tensor, act: torch.Tensor) -> torch.Tensor:
        # One token per tick: return-to-go, observation, and the previous action.
        steps = obs.shape[1]
        pieces = []
        previous = act.new_zeros(act.shape[0], ACT)
        for t in range(steps):
            pieces.append(torch.cat((rtg[:, t : t + 1], obs[:, t], previous), dim=-1))
            previous = act[:, t]
        hidden = self.embed(torch.stack(pieces, dim=1))
        return hidden + self.pos[:steps].unsqueeze(0)

    def forward(self, rtg: torch.Tensor, obs: torch.Tensor, act: torch.Tensor) -> torch.Tensor:
        hidden = self.tokens(rtg, obs, act)
        for block in self.blocks:
            hidden = block(hidden)
        return self.head(hidden)


def flat(tensor: torch.Tensor) -> list[float]:
    return [round(float(value), 5) for value in tensor.detach().reshape(-1).tolist()]


def linear_pair(layer: nn.Linear) -> tuple[list[float], list[float]]:
    return flat(layer.weight), flat(layer.bias)


def export_model(model: DecisionTransformer, probe: list[float], probe_past: list[float], targets: list[float]) -> None:
    blocks = []
    for block in model.blocks:
        wq, bq = linear_pair(block.wq)
        wk, bk = linear_pair(block.wk)
        wv, bv = linear_pair(block.wv)
        wo, bo = linear_pair(block.wo)
        w1, b1 = linear_pair(block.fc1)
        w2, b2 = linear_pair(block.fc2)
        blocks.append({
            'ln1w': flat(block.ln1.weight),
            'ln1b': flat(block.ln1.bias),
            'wq': wq, 'bq': bq, 'wk': wk, 'bk': bk, 'wv': wv, 'bv': bv, 'wo': wo, 'bo': bo,
            'ln2w': flat(block.ln2.weight),
            'ln2b': flat(block.ln2.bias),
            'w1': w1, 'b1': b1, 'w2': w2, 'b2': b2,
        })
    embed_w, embed_b = linear_pair(model.embed)
    head_w, head_b = linear_pair(model.head)
    payload = {
        'version': 1,
        'dModel': D,
        'layers': LAYERS,
        'heads': HEADS,
        'ff': FF,
        'context': CONTEXT,
        'obs': OBS,
        'target': TARGET,
        'embedW': embed_w,
        'embedB': embed_b,
        'pos': flat(model.pos),
        'blocks': blocks,
        'headW': head_w,
        'headB': head_b,
        'probe': [round(value, 5) for value in probe],
        'probePast': [round(value, 5) for value in probe_past],
        'targets': targets,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload))
    print(f'wrote {OUT} ({OUT.stat().st_size / 1e6:.2f} MB)')


def probe_of(model: DecisionTransformer) -> tuple[list[float], list[float]]:
    model.eval()
    with torch.no_grad():
        empty = model(torch.full((1, 1), TARGET), torch.zeros(1, 1, OBS), torch.zeros(1, 1, ACT))[0, 0]
        rtg = torch.full((1, 2), TARGET)
        obs = torch.zeros(1, 2, OBS)
        act = torch.zeros(1, 2, ACT)
        act[0, 0, 0] = 1
        past = model(rtg, obs, act)[0, 1]
    return [float(value) for value in empty.tolist()], [float(value) for value in past.tolist()]


def emphasize(episodes: list[dict]) -> list[dict]:
    buckets: dict[str, list[float]] = {}
    for episode in episodes:
        buckets.setdefault(str(episode.get('personality', '')), []).append(float(episode['return']))
    cutoff = {name: sorted(values)[int(0.75 * (len(values) - 1))] for name, values in buckets.items() if values}
    extra = [episode for episode in episodes if float(episode['return']) >= cutoff.get(str(episode.get('personality', '')), 0)]
    print(f'emphasized {len(extra)} high-return episodes')
    return episodes + extra + extra


def personality_targets(episodes: list[dict]) -> list[float]:
    names = ['fierce', 'cunning', 'guard', 'balanced']
    buckets = {name: [] for name in names}
    for episode in episodes:
        buckets.get(episode.get('personality', ''), []).append(float(episode['return']))
    targets = []
    for name in names:
        values = sorted(buckets[name]) or [TARGET]
        targets.append(round(values[-1], 3))
    print('targets', targets)
    return targets


def load_episodes(paths: list[str]) -> list[dict]:
    episodes = []
    for path in paths:
        with open(path, encoding='utf-8') as handle:
            for line in handle:
                line = line.strip()
                if line:
                    episodes.append(json.loads(line))
    return episodes


def batch_windows(episodes: list[dict], rng: torch.Generator) -> list[tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]]:
    windows = []
    for episode in episodes:
        steps = episode['steps']
        if not steps:
            continue
        ret = float(episode['return'])
        for end in range(len(steps)):
            start = max(0, end + 1 - CONTEXT)
            chunk = steps[start : end + 1]
            obs = torch.tensor([step['obs'] for step in chunk], dtype=torch.float32)
            act = torch.zeros(len(chunk), ACT)
            goal = torch.zeros(len(chunk), SLOTS, dtype=torch.long)
            for t, step in enumerate(chunk):
                for slot, tactic in enumerate(step['act']):
                    if 0 <= tactic < TACTICS:
                        act[t, slot * TACTICS + tactic] = 1
                        goal[t, slot] = tactic
                    else:
                        goal[t, slot] = -1
            windows.append((torch.full((len(chunk),), ret), obs, act, goal))
    return windows


def train(paths: list[str]) -> None:
    episodes = emphasize(load_episodes(paths))
    steps = sum(len(episode['steps']) for episode in episodes)
    print(f'episodes {len(episodes)} steps {steps}')
    torch.manual_seed(7)
    model = DecisionTransformer()
    opt = torch.optim.AdamW(model.parameters(), lr=3e-4, weight_decay=0.01)
    windows = batch_windows(episodes, torch.Generator())
    model.train()
    for epoch in range(8):
        order = torch.randperm(len(windows)).tolist()
        total = 0.0
        seen = 0
        for index in order:
            rtg, obs, act, goal = windows[index]
            logits = model(rtg.unsqueeze(0), obs.unsqueeze(0), act.unsqueeze(0))[0]
            loss = logits.new_zeros(())
            count = 0
            for slot in range(SLOTS):
                live = goal[:, slot] >= 0
                if int(live.sum()) == 0:
                    continue
                loss = loss + torch.nn.functional.cross_entropy(logits[live, slot * TACTICS : (slot + 1) * TACTICS], goal[live, slot])
                count += 1
            if count == 0:
                continue
            loss = loss / count
            opt.zero_grad()
            loss.backward()
            opt.step()
            total += float(loss.detach())
            seen += 1
        print(f'epoch {epoch} loss {total / max(1, seen):.4f}')
    empty, past = probe_of(model)
    export_model(model, empty, past, personality_targets(episodes))
    n_params = sum(p.numel() for p in model.parameters())
    print(f'params {n_params}')


def init_only() -> None:
    torch.manual_seed(1)
    model = DecisionTransformer()
    empty, past = probe_of(model)
    export_model(model, empty, past, [TARGET, TARGET, TARGET, TARGET])


if __name__ == '__main__':
    if '--init' in sys.argv:
        init_only()
    else:
        files = [arg for arg in sys.argv[1:] if not arg.startswith('--')]
        if not files:
            files = [str(ROOT / 'tools' / 'dt' / 'data' / 'trajectories.jsonl')]
        train(files)
