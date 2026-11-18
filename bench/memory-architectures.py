"""Offline paired retrieval pilot. Read pre-query snapshots as JSONL on stdin; emit counts only."""
import argparse
import json
import sys
import time
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer


def unit(x):
    return x / np.maximum(np.linalg.norm(x, axis=-1, keepdims=True), 1e-9)


class Encoder:
    def __init__(self, model, tokenizer):
        self.tok = Tokenizer.from_file(tokenizer)
        self.tok.enable_truncation(max_length=256)
        self.tok.enable_padding(pad_id=0, pad_token='[PAD]')
        opt = ort.SessionOptions()
        opt.intra_op_num_threads = 2
        self.session = ort.InferenceSession(model, opt, providers=['CPUExecutionProvider'])

    def embed(self, texts):
        vectors = []
        for start in range(0, len(texts), 8):
            enc = self.tok.encode_batch(texts[start:start+8])
            inputs = {k: np.asarray([getattr(e, attr) for e in enc], dtype=np.int64)
                      for k, attr in [('input_ids', 'ids'), ('attention_mask', 'attention_mask'), ('token_type_ids', 'type_ids')]}
            vectors.extend(self.session.run(None, inputs)[0][:, 0, :])
        return unit(np.asarray(vectors))


def shortlist(order, nodes):
    out, remaining = [], 1200
    for i in dict.fromkeys(order):
        size = len(nodes[i]['claim'].encode('utf8'))
        if size <= remaining:
            out.append(nodes[i]['id'])
            remaining -= size
        if len(out) == 3:
            break
    return out


def run(case, encoder):
    nodes = case['nodes']; pos = {n['id']: i for i, n in enumerate(nodes)}
    seeds = [pos[key] for key in case['seeds'] if key in pos]
    turns = [int(n['turn']) for n in nodes]
    orders = {'nodes': seeds}
    # Expand the strongest seed first; compare fixed adjacent turns vs the seed's own turn.
    for name, radius in [('window', 1), ('event', 0)]:
        order = []
        for i in seeds:
            order.append(i)
            order.extend(sorted((j for j in range(len(nodes)) if j != i and abs(turns[j]-turns[i])<=radius), key=lambda j: (abs(i-j),j)))
        orders[name] = order
    dense = encoder.embed([n['claim'] for n in nodes]); started = time.perf_counter()
    q = encoder.embed(['为这个句子生成表示以用于检索相关文章：' + case['query']])[0]
    query_ms = (time.perf_counter()-started)*1000
    cos = dense @ q
    # Exploratory event-first arm: bounded turn prefix, then rank nodes within the best event.
    # The request is historical; the current question is never part of an event key.
    groups = {}
    for i,t in enumerate(turns):
        groups.setdefault(t, []).append(i)
    labels = list(groups)
    requests = case['requests']
    if not all(1 <= t <= len(requests) for t in labels):
        raise ValueError('missing historical request for a node')
    descriptions = [requests[t-1][:180]+' '+ ' '.join(nodes[j]['claim'][:90] for j in groups[t][:3]) for t in labels]
    event_cos = encoder.embed(descriptions) @ q
    event_order = np.argsort(-event_cos, kind='stable')
    for tau in [0.0, 0.55, 0.65, 0.75]:
        orders[f'event-first@{tau}'] = [j for k in event_order if event_cos[k]>=tau
                                           for j in sorted(groups[labels[k]], key=lambda i:-cos[i])]
    # One frozen modern-Hopfield update, beta=12, identity projections; no task training.
    a = np.exp(12*(cos-cos.max())); assoc = dense @ unit((a/a.sum()) @ dense)
    for name, scores in [('vector', cos), ('hopfield', assoc)]:
        order = np.argsort(-scores, kind='stable')
        for tau in [0.0, 0.55, 0.65, 0.75]:
            # Both arms judge abstention against the original question, not the updated pattern.
            orders[f'{name}@{tau}'] = [i for i in order if cos[i]>=tau]
    gold = set(case['gold'])
    success = {name: bool(gold.intersection(picks)) if gold else not picks
               for name, order in orders.items() for picks in [shortlist(order,nodes)]}
    return {'key':case['key'], 'positive':bool(gold), 'ok':success, 'query_ms':round(query_ms,2)}


if __name__ == '__main__':
    cli = argparse.ArgumentParser()
    cli.add_argument('model'); cli.add_argument('tokenizer'); args = cli.parse_args()
    encoder = Encoder(args.model, args.tokenizer)
    rows = [run(json.loads(line), encoder) for line in sys.stdin if line.strip()]
    if not rows: raise ValueError('no snapshots')
    summary = {arm:[sum(r['ok'][arm] for r in rows if r['positive']==flag) for flag in [True,False]] for arm in rows[0]['ok']}
    print(json.dumps({'summary':summary,'cases':rows}, indent=2))
