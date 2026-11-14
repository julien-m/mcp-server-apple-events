import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

it('rejects fixture config that could override creation or target a supplied reminder ID', () => {
  const moduleUrl = pathToFileURL(
    resolve('examples/temporal-alarm-config.mjs'),
  ).href;
  const config = {
    listName: 'Synthetic list',
    timeoutMs: 20_000,
    minimumLeadMs: 60_000,
    writers: [
      { title: 'First', at: '2030-01-01T01:00:00Z' },
      { title: 'Second', at: '2030-01-01T02:00:00Z' },
    ],
    reminder: {
      title: 'Synthetic',
      temporalAlarm: { action: 'add', at: '2030-01-01T00:00:00Z' },
    },
  };
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { qualificationCreateArguments } from ${JSON.stringify(moduleUrl)};
    let input=''; for await (const chunk of process.stdin) input+=chunk;
    const config=JSON.parse(input);
    const valid=qualificationCreateArguments(config);
    const injected={...config,reminder:{...config.reminder,action:'delete',id:'personal-id',targetList:'Personal',expectedVersion:'old'}};
    let rejected=false; try { qualificationCreateArguments(injected); } catch { rejected=true; }
    console.log(JSON.stringify({valid,rejected}));
  `,
    ],
    { input: JSON.stringify(config), encoding: 'utf8', timeout: 1000 },
  );
  expect(child.status).toBe(0);
  const result = JSON.parse(child.stdout);
  expect(result.rejected).toBe(true);
  expect(result.valid).toMatchObject({
    action: 'create',
    targetList: config.listName,
  });
  expect(result.valid).not.toHaveProperty('id');
});
