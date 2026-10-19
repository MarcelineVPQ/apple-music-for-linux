import json, sys, numpy as np
O=sys.argv[1]; R=48000
a=np.fromfile(O+'/rec.f32',dtype='<f4'); a=a[:len(a)//4*4].reshape(-1,4)
CYC=np.dtype([("frame","<u8"),("nsec","<u8"),("pos","<u8"),("n","<u4"),("flags","<u4")])
cyc=np.fromfile(O+'/rec.cycles',dtype=CYC)
fr=cyc['frame'].astype(np.int64); ns=cyc['nsec'].astype(np.int64)
def t_of(f):
    i=np.clip(np.searchsorted(fr,f,side='right')-1,0,len(fr)-1); return ns[i]+(np.asarray(f)-fr[i])*1e9/R
def f_at(t):
    i=max(0,min(np.searchsorted(ns,t,side='right')-1,len(ns)-1)); return int(fr[i]+(t-ns[i])*R/1e9)
L=[json.loads(x) for x in open(O+'/log.jsonl')]
loud=(np.abs(a)>1e-6).any(1)
# source counter (whichever sink has content)
cnt=np.where(np.abs(a[:,1])>1e-6,a[:,1],a[:,3]).astype(np.float64)
src=np.rint(cnt*(1<<24)).astype(np.int64)-(1<<23)
src[~loud]=-1
def first(mask,f0,f1):
    idx=np.nonzero(mask[f0:f1])[0]; return f0+int(idx[0]) if len(idx) else None
def last(mask,f0,f1):
    idx=np.nonzero(mask[f0:f1])[0]; return f0+int(idx[-1]) if len(idx) else None
def ms(x): return round(x/1e6,1)
cmds=[x for x in L if x['k']=='cmd']; evs=[x for x in L if x['k']=='ev']
res={'tail':[],'lag':[],'seek':[],'src':[]}
# exactness: steps of the counter within content
d=np.diff(src); ok=(src[:-1]>=0)&(src[1:]>=0)
res['counter_steps_eq1_share']=float((d[ok]==1).mean())
for i,c in enumerate(cmds):
    t=int(c['t']); f=f_at(t); nxt=int(cmds[i+1]['t']) if i+1<len(cmds) else t+3e9; fn=f_at(nxt)
    evafter=[e for e in evs if int(e['t'])>=t and int(e['t'])<nxt]
    evt={e['ev']:ms(int(e['t'])-t) for e in reversed(evafter)}
    if c['c']=='pause':
        l=last(loud,max(0,f-R),fn)
        # last loud frame after cmd
        res['tail'].append(ms(t_of(l)-t) if l and l>=f else None)
    elif c['c']=='play':
        g=first(loud,f,fn); res['lag'].append({'lag':ms(t_of(g)-t) if g else None,'ev':evt})
    elif c['c'] in('seek','src'):
        # pre-change content continues until silence or jump
        w=src[max(0,f-R):f]; w=w[w>=0]; pre=w[-1] if len(w) else -10**9
        seg=src[f:fn]
        # old = continuation of the pre counter (src == pre + k)
        k=np.arange(1,len(seg)+1); old=(seg==pre+k)
        lo=last(old,0,len(seg)); 
        newm=(seg>=0)&~old
        g=first(newm,0,len(seg))
        gap_start=lo if lo is not None else -1
        r={'old_after_ms':ms(t_of(f+lo)-t) if lo is not None else 0,
           'first_new_ms':ms(t_of(f+g)-t) if g is not None else None,
           'silence_gap_ms':round((g-(gap_start+1))*1000/R,1) if g is not None else None,
           'ev':evt}
        if g is not None:
            r['new_starts_at_frame']=int(seg[g])
            # continuity after first new
            s2=seg[g:g+R]; s2=s2[s2>=0]; r['new_cont']=bool((np.diff(s2)==1).all())
        res[c['c']].append(r)
json.dump(res,open(O+'/summary.json','w'),indent=1)
def st(v):
    v=[x for x in v if x is not None]; return (min(v),float(np.median(v)),max(v),len(v)) if v else None
print('counter exact share',res['counter_steps_eq1_share'])
print('tail',st(res['tail']),res['tail'])
print('lag',st([x['lag'] for x in res['lag']]))
for k in ('seek','src'):
    print(k,'old_after',st([x['old_after_ms'] for x in res[k]]),'first_new',st([x['first_new_ms'] for x in res[k]]),'gap',st([x['silence_gap_ms'] for x in res[k]]))
    for x in res[k]: print('  ',x)
for x in res['lag'][:3]: print(x)
