import { describeAuthSetup } from '../_lib/auth.js';
import { handleOptions, json } from '../_lib/http.js';
import { modalBaseUrl } from '../_lib/modal.js';

export default async function handler(req: any, res: any) {
  if (handleOptions(req, res)) return;
  json(res, 200, {
    service: 'Trey Video API',
    version: 'v1',
    status: 'ok',
    modal_worker_configured: Boolean(modalBaseUrl()),
    products: ['video_removal', 'video_editor', 'opencut_sdk'],
    auth: describeAuthSetup(),
  });
}
