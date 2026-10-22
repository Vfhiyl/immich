<script lang="ts">
  import { Theme, themeManager } from '@immich/ui';
  import { DateTime } from 'luxon';
  import { onDestroy, onMount } from 'svelte';
  import uPlot, { type AlignedData, type Axis } from 'uplot';
  import 'uplot/dist/uPlot.min.css';

  type Props = {
    /** The days (as seconds), GiB stored, and the estimated cost of each day */
    series: [number[], number[], (number | null)[]];
    storedLabel: string;
    costLabel: string;
  };

  const { series, storedLabel, costLabel }: Props = $props();

  let chartElement: HTMLDivElement | undefined = $state();
  const isDark = $derived(themeManager.value === Theme.Dark);
  let plot: uPlot | undefined;

  const axis: Axis = {
    stroke: () => (isDark ? '#ccc' : 'black'),
    grid: { show: true, stroke: () => (isDark ? '#444' : '#ddd') },
    ticks: { show: false },
  };

  const hasCosts = $derived(series[2].some((cost) => cost !== null));

  const options = (): uPlot.Options => ({
    width: chartElement?.clientWidth ?? 600,
    height: 220,
    legend: { show: true },
    cursor: { drag: { setScale: false } },
    scales: { x: { time: true }, gib: { auto: true }, cost: { auto: true } },
    series: [
      { value: (_, value) => (value === null ? '' : DateTime.fromSeconds(value, { zone: 'utc' }).toISODate()!) },
      { label: storedLabel, scale: 'gib', stroke: '#4250af', width: 2, points: { show: false } },
      ...(hasCosts ? [{ label: costLabel, scale: 'cost', stroke: '#d97706', width: 2, points: { show: false } }] : []),
    ],
    axes: [
      {
        ...axis,
        values: (_, values) => values.map((value) => DateTime.fromSeconds(value, { zone: 'utc' }).toFormat('MM-dd')),
      },
      { ...axis, scale: 'gib', size: 60 },
      ...(hasCosts ? [{ ...axis, scale: 'cost', side: 1, size: 60, grid: { show: false } }] : []),
    ],
  });

  const data = $derived((hasCosts ? series : series.slice(0, 2)) as AlignedData);

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
