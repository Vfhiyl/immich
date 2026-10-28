import { getDerivedDimensions } from 'src/utils/derived-size.js';

describe(getDerivedDimensions.name, () => {
  it('should give images up to 16 MP:1440² their size as short side, as before', () => {
    expect(getDerivedDimensions({ width: 4032, height: 3024 }, 1440)).toEqual({ width: 1920, height: 1440 });
    expect(getDerivedDimensions({ width: 12_240, height: 16_320 }, 1440)).toEqual({ width: 1440, height: 1920 });
    expect(getDerivedDimensions({ width: 11_520, height: 4050 }, 1440)).toEqual({ width: 4096, height: 1440 });
    expect(getDerivedDimensions({ width: 3000, height: 22_000 }, 1440)).toEqual({ width: 1440, height: 10_560 });
    expect(getDerivedDimensions({ width: 4032, height: 3024 }, 250)).toEqual({ width: 333, height: 250 });
  });

  it('should not make an image larger', () => {
    expect(getDerivedDimensions({ width: 800, height: 600 }, 1440)).toEqual({ width: 800, height: 600 });
    expect(getDerivedDimensions({ width: 1080, height: 3000 }, 1440)).toEqual({ width: 1080, height: 3000 });
  });

  it('should give a long screenshot a preview of 16 MP at most, and a long thumbnail', () => {
    expect(getDerivedDimensions({ width: 1080, height: 10_000 }, 1440)).toEqual({ width: 1080, height: 10_000 });
    expect(getDerivedDimensions({ width: 1440, height: 15_000 }, 1440)).toEqual({ width: 1239, height: 12_910 });
    expect(getDerivedDimensions({ width: 1080, height: 20_000 }, 1440)).toEqual({ width: 885, height: 16_383 });
    expect(getDerivedDimensions({ width: 2160, height: 40_000 }, 1440)).toEqual({ width: 885, height: 16_383 });
    expect(getDerivedDimensions({ width: 1080, height: 20_000 }, 250)).toEqual({ width: 221, height: 4096 });
    expect(getDerivedDimensions({ width: 1080, height: 10_000 }, 250)).toEqual({ width: 250, height: 2315 });
  });

  it('should keep a panorama within what WebP allows', () => {
    expect(getDerivedDimensions({ width: 60_000, height: 3000 }, 1440)).toEqual({ width: 16_383, height: 819 });
    expect(getDerivedDimensions({ width: 200_000, height: 1440 }, 1440)).toEqual({ width: 16_383, height: 118 });
  });
});
