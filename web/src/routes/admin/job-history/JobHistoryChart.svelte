<script lang="ts">
  import { Theme, themeManager } from '@immich/ui';
  import { DateTime } from 'luxon';
  import { onDestroy, onMount } from 'svelte';
  import uPlot, { type AlignedData, type Axis } from 'uplot';
  import 'uplot/dist/uPlot.min.css';

  type Props = {
    /** The start of each bucket (as seconds), the jobs that succeeded, and those that failed */
    series: [number[], number[], number[]];
    /** Whether the buckets are hours (else days or months) */
    hourly: boolean;
    succeededLabel: string;
    failedLabel: string;
  };

  const { series, hourly, succeededLabel, failedLabel }: Props = $props();

  let chartElement: HTMLDivElement | undefined = $state();
  const isDark = $derived(themeManager.value === Theme.Dark);
  let plot: uPlot | undefined;

  const axis: Axis = {
    stroke: () => (isDark ? '#ccc' : 'black'),
    grid: { show: true, stroke: () => (isDark ? '#444' : '#ddd') },
    ticks: { show: false },
  };
  const format = (seconds: number) =>
    DateTime.fromSeconds(seconds).toLocaleString(hourly ? DateTime.DATETIME_SHORT : DateTime.DATE_SHORT);

  const options = (): uPlot.Options => ({
    width: chartElement?.clientWidth ?? 600,
    height: 220,
    legend: { show: true },
    cursor: { drag: { setScale: false } },
    scales: {
      // a single bucket (e.g. all, on a new server): around it, rather than uPlot's spread over years
      x: {
        time: true,
        // from the data itself: uPlot widens a single bucket to years before it asks
        range: (u) => {
          const buckets = u.data[0];
          const first = buckets[0] ?? 0;
          const last = buckets.at(-1) ?? first;
          const pad = hourly ? 3600 : 86_400;
          return first === last ? [first - pad, last + pad] : [first, last];
        },
      },
      succeeded: { auto: true },
      failed: { auto: true },
    },
    series: [
      { value: (_, value) => (value === null ? '' : format(value)) },
      {
        label: succeededLabel,
        scale: 'succeeded',
        stroke: '#4250af',
        width: 2,
        // a line needs two buckets
        points: { show: (u) => u.data[0].length < 2 },
      },
      { label: failedLabel, scale: 'failed', stroke: '#dc2626', width: 2, points: { show: true } },
    ],
    axes: [
      { ...axis },
      { ...axis, scale: 'succeeded', size: 60 },
      { ...axis, scale: 'failed', side: 1, size: 60, grid: { show: false } },
    ],
  });

  const data = $derived(series as AlignedData);

  onMount(() => {
    plot = new uPlot(options(), data, chartElement!);
    const resize = new ResizeObserver(() => plot?.setSize({ width: chartElement!.clientWidth, height: 220 }));
    resize.observe(chartElement!);
    return () => resize.disconnect();
  });

  $effect(() => {
    plot?.setData(data);
  });

  $effect(() => {
    if (themeManager.value) {
      plot?.redraw(false);
    }
  });

  onDestroy(() => plot?.destroy());
</script>

<div class="w-full" bind:this={chartElement}></div>
