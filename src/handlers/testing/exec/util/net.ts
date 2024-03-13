import net from 'net';
import { emitter, EventName } from '../emitter';

export async function findAvailablePort(args: {
  startPort: number;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryListening = (port: number) => {
      const server = net.createServer();

      server.listen(port, () => {
        server.once('close', () => {
          resolve(port);
        });
        server.close();
      });

      server.on('error', (err) => {
        if ((err as { code?: string } | undefined)?.code === 'EADDRINUSE') {
          const nextPort = port + 1;
          emitter.emit(EventName.CONSOLE_LOG, {
            ctx: 'cli',
            level: 'info',
            message: `Port ${port} is in use, trying port ${nextPort}...`,
          });
          tryListening(nextPort);
        } else {
          reject(err);
        }
      });
    };

    tryListening(args.startPort);
  });
}
