import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '127.0.0.1';

const app = createApp();
const server = app.listen(port, host, () => {
  console.log(`ContractGuard is listening at http://${host}:${port}`);
});

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    server.close((error) => {
      if (error) { console.error(error); process.exitCode = 1; }
    });
    Promise.all([app.locals.closeAgent?.(), app.locals.closeCaller?.()]).catch((error: unknown) => {
      console.error(error); process.exitCode = 1;
    });
  });
}
