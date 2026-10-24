import { ResourceCheckLevel, type ResourceCheckResponseDto } from '@immich/sdk';
import { render, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getAnimateMock } from '$lib/__mocks__/animate.mock';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { getVisualViewportMock } from '$lib/__mocks__/visual-viewport.mock';
import ResourceCheckReport from './ResourceCheckReport.svelte';

const GiB = 1024 ** 3;
const check = (overrides: Partial<ResourceCheckResponseDto> = {}): ResourceCheckResponseDto => ({
  memory: { bytes: 16 * GiB, source: 'machine', level: ResourceCheckLevel.Ok },
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
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
    vi.stubGlobal('visualViewport', getVisualViewportMock());
    Element.prototype.animate = getAnimateMock();
  });

  test('tells what the server has, with nothing below what is needed', () => {
    render(ResourceCheckReport, { check: check() });

    // the texts are keys in unit tests
    expect(screen.getByText('admin.resource_check_memory')).toBeInTheDocument();
    expect(screen.getByText('admin.resource_check_cpus')).toBeInTheDocument();
    expect(screen.getByText('admin.resource_check_disk')).toBeInTheDocument();
    expect(screen.queryByText(/below/)).not.toBeInTheDocument();
  });

  test('tells what is below the minimum or the recommendation', () => {
    render(ResourceCheckReport, {
      check: check({
        memory: { bytes: 4 * GiB, source: 'cgroup', level: ResourceCheckLevel.BelowMinimum },
        cpus: { cores: 2, source: 'machine', level: ResourceCheckLevel.BelowRecommended },
      }),
    });

    expect(screen.getByText(/admin.resource_check_memory.*admin.resource_check_below_minimum/)).toBeInTheDocument();
    expect(screen.getByText(/admin.resource_check_cpus.*admin.resource_check_below_recommended/)).toBeInTheDocument();
  });

  test('tells whether machine learning answers', () => {
    render(ResourceCheckReport, {
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

    expect(screen.getByText('admin.resource_check_ml_unreachable')).toBeInTheDocument();
    expect(screen.getByText('admin.resource_check_ml_reachable')).toBeInTheDocument();
    expect(screen.getByText('admin.resource_check_ml_reachable_unknown')).toBeInTheDocument();
  });
});
