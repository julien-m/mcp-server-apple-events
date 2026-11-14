import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { ReminderBusyError, ReminderWriteLock } from './write-lock.js';

it('serializes real independent processes sharing one lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reminder-lock-test-'));
  const counter = join(root, 'counter');
  const directory = join(root, 'write.lock');
  const source = readFileSync(join(__dirname, 'write-lock.ts'), 'utf8');
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`;
  const workers = Array.from({ length: 4 });
  const children: ReturnType<typeof spawn>[] = [];
  try {
    await writeFile(counter, '0');
    await Promise.all(
      workers.map(
        () =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              [
                '--input-type=module',
                '-e',
                `
        import { readFile, writeFile } from 'node:fs/promises';
        const { ReminderWriteLock } = await import(${JSON.stringify(moduleUrl)});
        const lock = new ReminderWriteLock(process.argv[1]);
        for (let index = 0; index < 3; index++) await lock.run(async () => {
          const count = Number(await readFile(process.argv[2], 'utf8'));
          await writeFile(process.argv[2], String(count + 1));
        });
      `,
                directory,
                counter,
              ],
              { stdio: ['ignore', 'ignore', 'pipe'] },
            );
            children.push(child);
            let stderr = '';
            child.stderr?.on('data', (chunk) => {
              stderr += chunk;
            });
            child.on('error', reject);
            child.on('exit', (code) =>
              code === 0
                ? resolve()
                : reject(new Error(stderr || `exit ${code}`)),
            );
          }),
      ),
    );
    expect(Number(await readFile(counter, 'utf8'))).toBe(workers.length * 3);
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    for (const child of children)
      if (child.exitCode === null) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

it('releases on error and refuses to steal a held lock on timeout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reminder-lock-test-'));
  const directory = join(root, 'write.lock');
  const lock = new ReminderWriteLock(directory, 5);
  try {
    await expect(
      lock.run(async () => {
        throw new Error('failed write');
      }),
    ).rejects.toThrow('failed write');
    await lock.run(async () => {
      await expect(
        new ReminderWriteLock(directory, 5).run(async () => 'unsafe'),
      ).rejects.toBeInstanceOf(ReminderBusyError);
      expect((await stat(directory)).isDirectory()).toBe(true);
    });
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('does not execute a cancelled queued write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reminder-lock-test-'));
  const directory = join(root, 'write.lock');
  const controller = new AbortController();
  const execute = jest.fn();
  try {
    await new ReminderWriteLock(directory).run(async () => {
      const pending = new ReminderWriteLock(directory).run(
        execute,
        controller.signal,
      );
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });
    expect(execute).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
