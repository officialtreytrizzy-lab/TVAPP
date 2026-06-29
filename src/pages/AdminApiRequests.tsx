import React, { useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2, KeyRound, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';

interface ApiKeyInquiry {
  id: string;
  status: 'pending' | 'approved' | 'denied';
  name: string;
  email: string;
  organization: string;
  use_case: string;
  website?: string;
  requested_scopes: string[];
  plan: string;
  created_at: string;
  reviewed_at?: string;
  reviewed_by?: string;
  decision_note?: string;
  approved_key_id?: string;
}

const storageKey = 'trey_video_admin_key';

const AdminApiRequests: React.FC = () => {
  const [adminKey, setAdminKey] = useState(() => localStorage.getItem(storageKey) || '');
  const [requests, setRequests] = useState<ApiKeyInquiry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [token, setToken] = useState<string | null>(null);

  const authHeaders = () => ({ Authorization: `Bearer ${adminKey}` });

  const loadRequests = async () => {
    setLoading(true);
    setError(null);
    setToken(null);
    try {
      localStorage.setItem(storageKey, adminKey);
      const response = await fetch('/api/v1/admin/api-key-requests?status=all', { headers: authHeaders() });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message || 'Could not load requests.');
      setRequests(payload.requests || []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (adminKey) loadRequests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const review = async (requestId: string, decision: 'approve' | 'deny') => {
    setLoading(true);
    setError(null);
    setToken(null);
    try {
      const response = await fetch('/api/v1/admin/api-key-review', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_id: requestId, decision, decision_note: note, reviewed_by: 'admin' }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message || 'Review failed.');
      if (payload.token) setToken(payload.token);
      await loadRequests();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-dvh bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-slate-950/80 pt-safe backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 px-safe">
          <a href="/api-docs" className="flex items-center gap-2 text-slate-200 hover:text-white">
            <ShieldCheck className="h-6 w-6 text-violet-300" />
            <span className="text-lg font-bold tracking-tight">Admin API Requests</span>
          </a>
          <a href="/api-docs" className="inline-flex items-center gap-2 rounded-lg bg-slate-800 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700">
            <ArrowLeft className="h-4 w-4" /> API docs
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-10">
        <section className="mb-6 rounded-3xl border border-slate-800 bg-slate-900/40 p-5 sm:p-6">
          <div className="mb-4 flex items-center gap-3">
            <KeyRound className="h-5 w-5 text-violet-300" />
            <h1 className="text-2xl font-bold">Admin approval portal</h1>
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <input type="password" value={adminKey} onChange={(e) => setAdminKey(e.target.value)} placeholder="Admin key" className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-violet-500" />
            <button onClick={loadRequests} disabled={!adminKey || loading} className="inline-flex items-center justify-center gap-2 rounded-xl bg-violet-600 px-5 py-3 font-semibold text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-60">
              <RefreshCw className="h-4 w-4" /> Load requests
            </button>
          </div>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional approval/denial note" className="mt-3 min-h-20 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-violet-500" />
        </section>

        {error && <div className="mb-5 rounded-2xl border border-red-700/50 bg-red-500/10 p-4 text-sm text-red-200">{error}</div>}
        {token && (
          <div className="mb-5 rounded-2xl border border-emerald-700/50 bg-emerald-500/10 p-4 text-sm text-emerald-100">
            <div className="mb-2 flex items-center gap-2 font-semibold"><CheckCircle2 className="h-4 w-4" /> Approved key issued. Copy it now.</div>
            <code className="block break-all rounded-xl bg-slate-950 p-3 text-emerald-200">{token}</code>
          </div>
        )}

        <div className="grid gap-4">
          {requests.map((request) => (
            <article key={request.id} className="rounded-3xl border border-slate-800 bg-slate-900/50 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-lg font-bold text-white">{request.name}</h2>
                    <span className={`rounded-full px-2 py-1 text-xs ${request.status === 'pending' ? 'bg-yellow-500/15 text-yellow-200' : request.status === 'approved' ? 'bg-emerald-500/15 text-emerald-200' : 'bg-red-500/15 text-red-200'}`}>{request.status}</span>
                  </div>
                  <p className="mt-1 text-sm text-slate-400">{request.email} · {request.organization} · {request.plan}</p>
                  <p className="mt-1 text-xs text-slate-500">{request.id} · {new Date(request.created_at).toLocaleString()}</p>
                </div>
                {request.status === 'pending' && (
                  <div className="flex gap-2">
                    <button onClick={() => review(request.id, 'approve')} disabled={loading} className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-60"><CheckCircle2 className="h-4 w-4" /> Approve</button>
                    <button onClick={() => review(request.id, 'deny')} disabled={loading} className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-60"><XCircle className="h-4 w-4" /> Deny</button>
                  </div>
                )}
              </div>
              <p className="mt-4 whitespace-pre-wrap text-sm text-slate-300">{request.use_case}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                {request.requested_scopes.map((scope) => <span key={scope} className="rounded-lg bg-slate-950 px-2 py-1 font-mono text-xs text-violet-200 ring-1 ring-slate-800">{scope}</span>)}
              </div>
              {request.website && <a href={request.website} className="mt-3 inline-block text-sm text-violet-300 hover:text-violet-200">{request.website}</a>}
              {request.approved_key_id && <p className="mt-3 text-xs text-emerald-300">Approved key ID: {request.approved_key_id}</p>}
              {request.decision_note && <p className="mt-3 text-xs text-slate-500">Admin note: {request.decision_note}</p>}
            </article>
          ))}
          {!requests.length && !loading && <div className="rounded-3xl border border-slate-800 bg-slate-900/40 p-8 text-center text-slate-400">No API key requests loaded.</div>}
        </div>
      </main>
    </div>
  );
};

export default AdminApiRequests;
