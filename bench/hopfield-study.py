"""CPU-only retrieval lab. Inputs and model are local; outputs omit queries and claims."""
import argparse
import importlib.util
import itertools
import json
from pathlib import Path
import sys
import time
import numpy as np

spec = importlib.util.spec_from_file_location('arch', Path(__file__).with_name('memory-architectures.py'))
arch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(arch)
TAU = (0, .25, .35, .45, .55, .65, .75, .85, .95)
HOPS = tuple(itertools.product((4, 12, 36), (1, 2, 3), (0., .5)))


def paired(x, y):
    return {'gained': sum(b and not a for a,b in zip(x,y)), 'lost': sum(a and not b for a,b in zip(x,y))}


def prepare(case, enc, cache):
    nodes = case['nodes']; texts = [n['claim'] for n in nodes]
    missing = list(dict.fromkeys(t for t in texts if t not in cache))
    if missing: cache.update(zip(missing, enc.embed(missing)))
    start = time.perf_counter(); q = enc.embed(['为这个句子生成表示以用于检索相关文章：' + case['query']])[0]
    case['qms'] = (time.perf_counter()-start)*1000
    d = np.stack([cache[t] for t in texts]); pos = {n['id']:i for i,n in enumerate(nodes)}
    seeds = [pos[k] for k in case['seeds'] if k in pos]
    live = np.array([n.get('valid_to') is None and n.get('state') in ('active','retired') for n in nodes]); ids = np.flatnonzero(live)
    graph = [i for i in seeds if live[i]]; mem = d[ids]; cos = d @ q
    priority = np.zeros(len(nodes)); priority[graph] = [.12/(i+1) for i in range(len(graph))]
    result = {}

    def save(arm, par, order):
        picks = arch.shortlist(order, nodes); gold = set(case['gold']); rank = next((i for i,k in enumerate(picks,1) if k in gold),0)
        result[arm,par] = (bool(rank) if gold else not picks, rank, any(not live[pos[k]] for k in picks))

    save('graph_raw', (), seeds); save('graph_current', (), graph)
    def ranks(name, scores, par, hybrid):
        scores = scores + (priority[ids] if hybrid else 0)
        order = ids[np.argsort(-scores,kind='stable')].tolist()
        if hybrid and graph: order = [graph[0]]+[i for i in order if i!=graph[0]]
        for tau in TAU:
            accepted=[i for i in order if cos[i]>=tau]
            save(name, (*par,tau), accepted)
            if hybrid: save(name+'-fill', (*par,tau), graph+accepted)

    for hybrid, prefix in [(False,''),(True,'graph+')]:
        ranks(prefix+'vector',cos[ids],(),hybrid)
        for beta, steps, retain in HOPS:
            pattern=q
            for _ in range(steps):
                logits=mem @ pattern
                if not len(logits): break
                a=np.exp(beta*(logits-logits.max())); centre=(a/a.sum()) @ mem
                pattern=arch.unit(retain*q+(1-retain)*centre)
            ranks(prefix+'hopfield',mem @ pattern,(beta,steps,retain),hybrid)
    return result


def report(cases, outcomes, indices, arm, par):
    rows=[outcomes[i][arm,par] for i in indices]; pos=[bool(cases[i]['gold']) for i in indices]
    vals=[bool(r[0]) for r in rows]; n=sum(pos); m=len(pos)-n
    hit=sum(ok and p for ok,p in zip(vals,pos)); abstain=sum(ok and not p for ok,p in zip(vals,pos))
    return dict(hit3=hit, positives=n, abstained=abstain, negatives=m, stale_cases=sum(r[2] for r in rows),
                mrr=round(sum(1/r[1] for r in rows if r[1])/max(1,n),4),
                balanced=(hit/max(n,1)+abstain/max(m,1))/2, cases=vals)


def main():
    cli=argparse.ArgumentParser(); cli.add_argument('model');cli.add_argument('tokenizer');args=cli.parse_args()
    cases=[json.loads(line) for line in sys.stdin if line.strip()]; enc=arch.Encoder(args.model,args.tokenizer);cache={}
    splits={s:[i for i,c in enumerate(cases) if c.get('split','real')==s] for s in ['dev','test','real']}
    if not splits['dev'] or not splits['test']: raise ValueError('need both development and held-out topics')
    for row in cases:
        known={n['id'] for n in row['nodes']}
        if set(row['gold'])-known or len(known)!=len(row['nodes']): raise ValueError('invalid gold or duplicate node')
    out=[prepare(c,enc,cache) for c in cases]; result={'parameters':{},'splits':{},'ablation':{},'paired':{}}
    for arm in ['graph_raw','graph_current','vector','hopfield','graph+vector','graph+hopfield','graph+vector-fill','graph+hopfield-fill']:
        grid=[p for k,p in out[0] if k==arm]; dev=splits['dev']
        def key(p):
            r=report(cases,out,dev,arm,p); return r['balanced'],r['abstained'],r['mrr']
        par=max(grid,key=key);result['parameters'][arm]=par
        for name,indices in splits.items():
            if indices: result['splits'].setdefault(name,{})[arm]=report(cases,out,indices,arm,par)
        if arm.endswith('hopfield'):
            for steps in [1,2,3]:
                best=max((p for p in grid if p[1]==steps),key=key)
                result['ablation'].setdefault(arm,{})[steps]={'params':best, 'test':report(cases,out,splits['test'],arm,best)}
    for name,arms in result['splits'].items():
        result['paired'][name]={}
        for a,b in [('graph_current','graph+hopfield'),('vector','hopfield'),('graph+vector','graph+hopfield'),('graph_current','graph+hopfield-fill'),('graph+vector-fill','graph+hopfield-fill')]:
            result['paired'][name][a+' -> '+b]=paired(arms[a]['cases'],arms[b]['cases'])
    result['keys']={k:[cases[i]['key'] for i in v] for k,v in splits.items()}
    result['query_encoding_ms_p50']=float(np.median([c['qms'] for c in cases]))
    print(json.dumps(result,indent=2))

if __name__=='__main__':main()
