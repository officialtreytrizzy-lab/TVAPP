import React, { useState } from 'react';
import { ArrowLeft, CheckCircle2, KeyRound, Send, Wand2 } from 'lucide-react';

interface FormState {
  name: string;
  email: string;
  organization: string;
  website: string;
  use_case: string;
  plan: string;
  requested_scopes: string;
}

const initialForm: FormState = {
  name: '',
  email: '',
  organization: '',
  website: '',
  use_case: '',
  plan: 'starter',
  requested_scopes: 'video_removal:write video_removal:read video_editor:write video_editor:read',
};

const ApiKeyRequest: React.FC = () => {
  const [form, setForm] = useState<FormState>(initialForm);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const update = (field: keyof FormState, value: string) => setForm((current) => ({ ...current, [field]: value }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setResult(null);
    setError(null);

    try {
      const response = await fetch('/api/v1/api-key-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          requested_scopes: form.requested_scopes.split(/[\s,]+/).filter(Boolean),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message || 'Request failed.');
      setResult(`Submitted. Request ID: ${payload.request_id}`);
      setForm(initialForm);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-dvh bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-slate-950/80 pt-safe backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3 px-safe">
          <a href="/api-docs" className="flex items-center gap-2 text-slate-200 hover:text-white">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-600 to-blue-600"><Wand2 className="h-5 w-5 text-white" /></div>
            <span className="text-lg font-bold tracking-tight">Trey Video API</span>
          </a>
          <a href="/api-docs" className="inline-flex items-center gap-2 rounded-lg bg-slate-800 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700">
            <ArrowLeft className="h-4 w-4" /> Docs
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-12">
        <div className="mb-8">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-violet-500/30 bg-violet-500/10 px-4 py-1.5 text-xs font-medium text-violet-200">
            <KeyRound className="h-3.5 w-3.5" /> API access request
          </div>
          <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">Request a Trey Video API key</h1>
          <p className="mt-4 max-w-2xl text-slate-300">Submit your project details. The inquiry appears in the admin portal where it can be approved or denied.</p>
        </div>

        <form onSubmit={submit} className="rounded-3xl border border-slate-800 bg-slate-900/40 p-6 sm:p-8">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-2 text-sm font-medium text-slate-200">Name<input value={form.name} onChange={(e) => update('name', e.target.value)} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-violet-500" required /></label>
            <label className="space-y-2 text-sm font-medium text-slate-200">Email<input type="email" value={form.email} onChange={(e) => update('email', e.target.value)} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-violet-500" required /></label>
            <label className="space-y-2 text-sm font-medium text-slate-200">Organization<input value={form.organization} onChange={(e) => update('organization', e.target.value)} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-violet-500" placeholder="Company, app, or artist name" /></label>
            <label className="space-y-2 text-sm font-medium text-slate-200">Website<input value={form.website} onChange={(e) => update('website', e.target.value)} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-violet-500" placeholder="https://" /></label>
            <label className="space-y-2 text-sm font-medium text-slate-200">Plan<select value={form.plan} onChange={(e) => update('plan', e.target.value)} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-violet-500"><option value="starter">Starter</option><option value="pro">Pro</option><option value="enterprise">Enterprise</option></select></label>
            <label className="space-y-2 text-sm font-medium text-slate-200">Requested scopes<input value={form.requested_scopes} onChange={(e) => update('requested_scopes', e.target.value)} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-violet-500" /></label>
          </div>
          <label className="mt-4 block space-y-2 text-sm font-medium text-slate-200">Use case<textarea value={form.use_case} onChange={(e) => update('use_case', e.target.value)} className="min-h-36 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-violet-500" placeholder="Tell us what you are building and how you plan to use the API." required /></label>

          {result && <div className="mt-5 flex items-center gap-2 rounded-2xl border border-emerald-700/50 bg-emerald-500/10 p-4 text-sm text-emerald-200"><CheckCircle2 className="h-4 w-4" /> {result}</div>}
          {error && <div className="mt-5 rounded-2xl border border-red-700/50 bg-red-500/10 p-4 text-sm text-red-200">{error}</div>}

          <button disabled={loading} className="mt-6 inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-blue-600 px-6 py-3 font-semibold text-white shadow-lg shadow-violet-900/40 hover:from-violet-500 hover:to-blue-500 disabled:cursor-not-allowed disabled:opacity-60">
            <Send className="h-4 w-4" /> {loading ? 'Submitting...' : 'Submit for admin approval'}
          </button>
        </form>
      </main>
    </div>
  );
};

export default ApiKeyRequest;
