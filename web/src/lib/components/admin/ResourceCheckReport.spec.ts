import { ResourceCheckLevel, type ResourceCheckResponseDto } from '@immich/sdk';
import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import ResourceCheckReport from './ResourceCheckReport.svelte';

const GiB = 1024 ** 3;
const check = (overrides: Partial<ResourceCheckResponseDto> = {}): ResourceCheckResponseDto => ({
  memory: { bytes: 16 * GiB, source: 'machine', level: ResourceCheckLevel.Ok },
  swap: { bytes: 0, source: 'machine', level: ResourceCheckLevel.Ok, neededForMinimum: 0, neededForRecommended: 0 },
  memoryKills: { lastWeek: 0, lastAt: null },
  cpus: { cores: 8, source: 'machine', level: ResourceCheckLevel.Ok },
  disk: { path: '/data', free: 500 * GiB, total: 1000 * GiB, level: ResourceCheckLevel.Ok },
  machineLearning: { enabled: true, services: [] },
  requirements: {
    memoryMinimum: 6 * GiB,
    memoryRecommended: 8 * GiB,
    cpusMinimum: 2,
    cpusRecommended: 4,
    diskMinimum: 20 * GiB,
  },
  ...overrides,
});

describe('ResourceCheckReport component', () => {
  test('tells what the server has, with nothing below what is needed', async () => {
    await render(ResourceCheckReport, { check: check() });

    // the texts are keys in unit tests
    await expect.element(page.getByText('admin.resource_check_memory')).toBeInTheDocument();
    await expect.element(page.getByText('admin.resource_check_cpus')).toBeInTheDocument();
    await expect.element(page.getByText('admin.resource_check_disk')).toBeInTheDocument();
    await expect.element(page.getByText(/below/)).not.toBeInTheDocument();
  });

  test('tells what is below the minimum or the recommendation', async () => {
    await render(ResourceCheckReport, {
      check: check({
        memory: { bytes: 4 * GiB, source: 'cgroup', level: ResourceCheckLevel.BelowMinimum },
        cpus: { cores: 2, source: 'machine', level: ResourceCheckLevel.BelowRecommended },
      }),
    });

    await expect
      .element(page.getByText(/admin.resource_check_memory.*admin.resource_check_below_minimum/))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(/admin.resource_check_cpus.*admin.resource_check_below_recommended/))
      .toBeInTheDocument();
  });

  test('tells how much swap to add on a machine of little memory', async () => {
    await render(ResourceCheckReport, {
      check: check({
        memory: { bytes: GiB, source: 'machine', level: ResourceCheckLevel.BelowMinimum },
        swap: {
          bytes: 2 * GiB,
          source: 'machine',
          level: ResourceCheckLevel.BelowMinimum,
          neededForMinimum: 3 * GiB,
          neededForRecommended: 5 * GiB,
        },
      }),
    });

    await expect.element(page.getByTestId('resource-swap')).toBeInTheDocument();
    expect(page.getByTestId('resource-swap').element().textContent).toMatch(
      /admin.resource_check_swap.*admin.resource_check_swap_add/,
    );
    await expect.element(page.getByTestId('resource-memory-kills')).not.toBeInTheDocument();
  });

  test('tells no swap to add with enough memory', async () => {
    await render(ResourceCheckReport, { check: check() });

    await expect.element(page.getByTestId('resource-swap')).toBeInTheDocument();
    expect(page.getByTestId('resource-swap').element().textContent).not.toMatch(/swap_add/);
  });

  test('tells when the background work ran out of memory', async () => {
    await render(ResourceCheckReport, {
      check: check({ memoryKills: { lastWeek: 3, lastAt: '2026-11-01T10:00:00.000Z' } }),
    });

    await expect
      .element(page.getByTestId('resource-memory-kills'))
      .toHaveTextContent('admin.resource_check_memory_kills');
  });

  test('tells whether machine learning answers', async () => {
    await render(ResourceCheckReport, {
      check: check({
        machineLearning: {
          enabled: true,
          services: [
            { url: 'http://a:3003', reachable: false, memory: null },
            { url: 'http://b:3003', reachable: true, memory: { used: GiB, limit: 8 * GiB, source: 'cgroup2' } },
            { url: 'http://c:3003', reachable: true, memory: null },
          ],
        },
      }),
    });

    await expect.element(page.getByText('admin.resource_check_ml_unreachable')).toBeInTheDocument();
    await expect.element(page.getByText('admin.resource_check_ml_reachable')).toBeInTheDocument();
    await expect.element(page.getByText('admin.resource_check_ml_reachable_unknown')).toBeInTheDocument();
  });
});
