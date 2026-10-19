import json, sys, numpy as np
O=sys.argv[1]; which=sys.argv[2]; idx=int(sys.argv[3]); R=48000
a=np.fromfile(O+'/rec.f32',dtype='<f4'); a=a[:len(a)//4*4].reshape(-1,4)
CYC=np.dtype([("frame","<u8"),("nsec","<u8"),("pos","<u8"),("n","<u4"),("flags","<u4")])
cyc=np.fromfile(O+'/rec.cycles',dtype=CYC); fr=cyc['frame'].astype(np.int64); ns=cyc['nsec'].astype(np.int64)
def f_at(t):
    i=max(0,min(np.searchsorted(ns,t,side='right')-1,len(ns)-1)); return int(fr[i]+(t-ns[i])*R/1e9)
L=[json.loads(x) for x in open(O+'/log.jsonl')]
c=[x for x in L if x['k']=='cmd' and x['c']==which][idx]; f=f_at(int(c['t']))
ch=1 if np.abs(a[f-R:f+R,1]).max()>0 else 3
x=a[f-200:f+int(0.25*R),ch].astype(np.float64); v=np.rint(x*(1<<24)).astype(np.int64)-(1<<23)
l=a[f-200:f+int(0.25*R),ch-1]
# print run summary: segments of (exact continuation) / silent / other
prev=None; start=0; kind=None
def k(i):
    if abs(x[i])<1e-6: return 'sil'
    if 0.5<=x[i]<1 and i>0 and v[i]==v[i-1]+1: return 'cont'
    return 'other'
out=[]
for i in range(1,len(x)):
    kk=k(i)
    if kk!=kind:
        if kind: out.append((kind,(start-200)*1000/R,(i-start)*1000/R, int(v[start]) if kind!='sil' else None, float(x[start])))
        kind=kk; start=i
out.append((kind,(start-200)*1000/R,(len(x)-start)*1000/R,int(v[start]),float(x[start])))
for o in out[:40]: print('%-5s at %7.1f ms dur %7.1f ms v=%s x=%.4f'%o)
