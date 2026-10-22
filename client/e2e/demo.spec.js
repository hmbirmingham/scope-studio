import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

// The student demo's talk track (docs/demo.md), against the real engine that
// `npm run demo` starts, with the scripted demo model in place of Ollama's
// chat (see playwright.demo.config.js). Every step saves a screenshot, so the
// demo can be reviewed without running it.

const SHOTS = process.env.DEMO_SHOTS_DIR;

async function shot(page, testInfo, name) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: 'image/png' });
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    copyFileSync(path, join(SHOTS, `${name}.png`));
  }
}

test('the student demo: map, agent, run, approval, artifact', async ({ page }, testInfo) => {
  // 1. Open the app: no sign-in, the student's project is on the map.
  await page.goto('/');
  await expect(page.getByRole('button', { name: /^PHYS 101 Pendulum Lab\d/ })).toBeVisible();
  await expect(page.locator('.graph-canvas')).toBeVisible();
  await expect(page.getByPlaceholder('email')).toHaveCount(0);
  await page.waitForTimeout(1500); // let the map settle before the picture
  await shot(page, testInfo, '01-project-map');

  // 2. The ready-made agent and its tasks, one of them on a weekly schedule.
  await page.getByRole('tab', { name: 'Agents' }).click();
  const agents = page.getByRole('list', { name: 'Your agents' });
  await expect(agents.getByText('Lab Partner')).toBeVisible();
  await expect(agents.getByText('Physicist · Supervised · Local only')).toBeVisible();
  const tasks = page.getByRole('region', { name: 'Tasks and schedules' });
  await expect(tasks.getByText('Weekly study guide')).toBeVisible();
  await expect(tasks.getByText(/At 18:00 UTC on Sunday/)).toBeVisible();
  await shot(page, testInfo, '02-agent-and-tasks');

  // 3. Start the task; the Activity tab follows the run live.
  await page.getByRole('button', { name: 'Run Check my lab report against the data now' }).click();
  const run = page.locator('.ws-run');
  await expect(page.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true');
  await expect(run.locator('.ws-run-instructions')).toContainText('Recompute g from pendulum-data.csv');
  await expect(run.locator('.ws-step').first()).toBeVisible();
  await expect(run.locator('.ws-run-head .ws-status')).toHaveText('Running');
  await shot(page, testInfo, '03-run-streaming');

  // 4. Running model-written code asks first; the code is there to read.
  const approve = run.getByRole('button', { name: /^Approve/ });
  await expect(approve).toBeVisible({ timeout: 60_000 });
  await expect(run.locator('.ws-run-head .ws-status')).toHaveText('Waiting for approval');
  await expect(page.getByRole('tab', { name: /Approvals/ }).getByLabel('1 pending')).toBeVisible();
  await shot(page, testInfo, '04-approval-requested');

  await approve.click();

  // 5. The analysis runs in the OS sandbox, the fixes are saved, the run ends.
  await expect(run.locator('.ws-run-head .ws-status')).toHaveText('Succeeded', { timeout: 60_000 });
  await expect(run.getByText(/g = 9\.78 ± 0\.04 m\/s²/).first()).toBeVisible();
  const highlights = run.getByRole('region', { name: 'Findings and artifacts' });
  const artifact = highlights.getByRole('button', { name: /Show artifact .*Lab report check/ });
  await expect(artifact).toBeVisible();
  await shot(page, testInfo, '05-run-succeeded');

  // 6. Read the fixes where the run is.
  await highlights.getByRole('button', { name: 'Read' }).first().click();
  await expect(highlights.getByText(/The point is not an outlier/)).toBeVisible();
  await highlights.scrollIntoViewIfNeeded();
  await shot(page, testInfo, '06-artifact-read');

  // 7. The artifact is a node on the map, linked to what it was made from.
  await artifact.click();
  const inspector = page.locator('.inspector');
  await expect(inspector).toBeVisible();
  await expect(inspector.getByText(/Lab report check: what to fix before Friday/).first()).toBeVisible();
  await page.waitForTimeout(1200);
  await expect(inspector.getByText(/derived_from/).first()).toBeVisible();
  await shot(page, testInfo, '07-artifact-on-map');
});
