import React from 'react';
import { ArrowLeft, CheckCircle2, Code2, KeyRound, ShieldCheck, Terminal, Video, Wand2 } from 'lucide-react';

const endpoints = [
  {
    method: 'GET',
    path: '/api/v1/health',
    scope: 'none',
    description: 'Confirms the API is online.',
  },
  {
    method: 'POST',
    path: '/api/v1/video-removal/jobs',
    scope: 'video_removal:write',
    description: 'Creates a video object-removal job from a source video and mask.',
  },
  {
    method: 'GET',
    path: '/api/v1/video-removal/jobs/{jobId}',
    scope: 'video_removal:read',
    description: 'Checks status, progress, and output availability for a job.',
  },
  {
    method: 'GET',
    path: '/api/v1/video-removal/jobs/{jobId}/output',
    scope: 'video_removal:read',
    description: 'Downloads or streams the finished MP4 output when ready.',
  },
  {
    method: 'POST',
    path: '/api/v1/video-editor/render-jobs',
    scope: 'video_editor:write',
    description: 'Creates an OpenCut/mobile-editor render job.',
  },
];

const curlExample = `curl -X POST https://your-domain.com/api/v1/video-removal/jobs \\
  -H "Authorization: Bearer YOUR_TREY_VIDEO_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "source_video_url": "https://example.com/source.mp4",
    "mask_url": "https://example.com/mask.png",
    "mode": "moving_object",
    "quality": "source",
    "preserve_audio": true
  }'`;

const ApiDocs: React.FC = () => {
  return (
    <div className="min-h-dvh bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-slate-950/80 pt-safe backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 px-safe">
          <a href="/" className="flex items-center gap-2 text-slate-200 hover:text-white">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-600 to-blue-600">
              <Wand2 className="h-5 w-5 text-white" />
            </div>
            <span className="text-lg font-bold tracking-tight">Video E<span className="text-violet-400">Treyser</span></span>
          </a>
          <a href="/" className="inline-flex items-center gap-2 rounded-lg bg-slate-800 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700">
            <ArrowLeft className="h-4 w-4" /> Back to app
          </a>
        </div>
      </header>

      <main>
        <section className="relative overflow-hidden border-b border-slate-800">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(124,58,237,0.28),transparent_45%),radial-gradient(circle_at_bottom_right,rgba(37,99,235,0.18),transparent_35%)]" />
          <div className="relative mx-auto max-w-6xl px-4 py-16 sm:py-24">
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-violet-500/30 bg-violet-500/10 px-4 py-1.5 text-xs font-medium text-violet-200">
              <Code2 className="h-3.5 w-3.5" /> Trey Video API
            </div>
            <h1 className="max-w-3xl text-4xl font-extrabold tracking-tight sm:text-6xl">
              Build video erasing and mobile editor workflows into your own app.
            </h1>
            <p className="mt-5 max-w-2xl text-lg text-slate-300">
              Use the same Video ETreyser pipeline from code: create object-removal jobs, check status, stream finished MP4s, and route mobile editor render jobs through protected API endpoints.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a href="#endpoints" className="rounded-xl bg-gradient-to-r from-violet-600 to-blue-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-violet-900/40 hover:from-violet-500 hover:to-blue-500">View endpoints</a>
              <a href="#auth" className="rounded-xl bg-slate-800 px-6 py-3 text-sm font-semibold text-white ring-1 ring-slate-700 hover:bg-slate-700">Authentication</a>
            </div>
          </div>
        </section>

        <section className="mx-auto grid max-w-6xl gap-4 px-4 py-10 sm:grid-cols-3">
          <div className="rounded-2xl bg-slate-900/60 p-5 ring-1 ring-slate-800">
            <Video className="mb-3 h-6 w-6 text-violet-300" />
            <h2 className="font-semibold text-white">Video removal</h2>
            <p className="mt-2 text-sm text-slate-400">Submit a clip and mask, then receive a clean MP4 output after the GPU worker finishes.</p>
          </div>
          <div className="rounded-2xl bg-slate-900/60 p-5 ring-1 ring-slate-800">
            <KeyRound className="mb-3 h-6 w-6 text-violet-300" />
            <h2 className="font-semibold text-white">Scoped API keys</h2>
            <p className="mt-2 text-sm text-slate-400">Protected endpoints require bearer keys with read or write scopes for the requested workflow.</p>
          </div>
          <div className="rounded-2xl bg-slate-900/60 p-5 ring-1 ring-slate-800">
            <ShieldCheck className="mb-3 h-6 w-6 text-violet-300" />
            <h2 className="font-semibold text-white">Commercial guardrails</h2>
            <p className="mt-2 text-sm text-slate-400">Use videos you own or have permission to edit, and keep model/license clearance in place before production use.</p>
          </div>
        </section>

        <section id="auth" className="mx-auto max-w-6xl px-4 py-8">
          <div className="rounded-3xl border border-slate-800 bg-slate-900/40 p-6 sm:p-8">
            <div className="mb-4 flex items-center gap-3">
              <KeyRound className="h-6 w-6 text-violet-300" />
              <h2 className="text-2xl font-bold text-white">Authentication</h2>
            </div>
            <p className="text-slate-300">
              Send protected requests with an API key in the Authorization header.
            </p>
            <pre className="mt-4 overflow-x-auto rounded-2xl bg-slate-950 p-4 text-sm text-slate-200 ring-1 ring-slate-800"><code>Authorization: Bearer YOUR_TREY_VIDEO_API_KEY</code></pre>
          </div>
        </section>

        <section id="endpoints" className="mx-auto max-w-6xl px-4 py-8">
          <div className="mb-5 flex items-center gap-3">
            <Terminal className="h-6 w-6 text-violet-300" />
            <h2 className="text-2xl font-bold text-white">Endpoints</h2>
          </div>
          <div className="overflow-hidden rounded-3xl border border-slate-800 bg-slate-900/40">
            <div className="grid grid-cols-12 gap-3 border-b border-slate-800 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <div className="col-span-2">Method</div>
              <div className="col-span-5">Path</div>
              <div className="col-span-2">Scope</div>
              <div className="col-span-3">Use</div>
            </div>
            {endpoints.map((endpoint) => (
              <div key={`${endpoint.method}-${endpoint.path}`} className="grid grid-cols-12 gap-3 border-b border-slate-800/70 px-4 py-4 text-sm last:border-b-0">
                <div className="col-span-12 sm:col-span-2"><span className="rounded-lg bg-violet-500/15 px-2 py-1 font-mono text-xs text-violet-200">{endpoint.method}</span></div>
                <div className="col-span-12 break-words font-mono text-slate-200 sm:col-span-5">{endpoint.path}</div>
                <div className="col-span-12 font-mono text-xs text-slate-400 sm:col-span-2">{endpoint.scope}</div>
                <div className="col-span-12 text-slate-400 sm:col-span-3">{endpoint.description}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-8 pb-16">
          <div className="rounded-3xl border border-slate-800 bg-slate-900/40 p-6 sm:p-8">
            <div className="mb-4 flex items-center gap-3">
              <CheckCircle2 className="h-6 w-6 text-emerald-300" />
              <h2 className="text-2xl font-bold text-white">Example request</h2>
            </div>
            <pre className="overflow-x-auto rounded-2xl bg-slate-950 p-4 text-sm text-slate-200 ring-1 ring-slate-800"><code>{curlExample}</code></pre>
          </div>
        </section>
      </main>
    </div>
  );
};

export default ApiDocs;
