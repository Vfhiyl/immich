import 'dart:async';
import 'dart:ffi' show Pointer, Uint8, Uint8Pointer;
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:ffi/ffi.dart';
import 'package:flutter/widgets.dart';
import 'package:immich_mobile/platform/region_image_api.g.dart';
import 'package:logging/logging.dart';

// Very large images (photos of 100 MP and more, long screenshots) are never decoded whole: the viewer shows a smaller
// image of the whole (the base, which its image provider decodes, see [regionBaseSize]), and over it the part on the
// screen, decoded at the scale it is shown, in tiles, by the app's own decoders (native/region).

/// The side of a tile, in pixels of the tile
const _kTileSize = 512;

/// The tiles kept decoded (those on the screen may take more)
const _kCacheBytes = 64 * 1024 * 1024;

/// The decodes asked for at once (the platform decodes two at a time)
const _kMaxPending = 4;

/// The size of the base: at most twice the pixels of the screen, and 4096 pixels on its long side (the smallest
/// largest texture Vulkan allows; Flutter shrinks larger images to fit the GPU). Tiles show what it lacks.
Size regionBaseSize(int width, int height, Size screen) {
  final budget = screen.width * screen.height * 2;
  final scale = math.min(1.0, math.min(math.sqrt(budget / (width * height)), 4096 / math.max(width, height)));
  return Size(math.max(1, (width * scale).roundToDouble()), math.max(1, (height * scale).roundToDouble()));
}

@immutable
class _TileKey {
  final int sample;
  final int column;
  final int row;

  const _TileKey(this.sample, this.column, this.row);

  @override
  bool operator ==(Object other) =>
      other is _TileKey && other.sample == sample && other.column == column && other.row == row;

  @override
  int get hashCode => Object.hash(sample, column, row);
}

class _Tile {
  final ui.Image image;

  /// In pixels of the image
  final Rect rect;
  final int sample;

  const _Tile(this.image, this.rect, this.sample);

  int get bytes => image.width * image.height * 4;
}

@immutable
class _View {
  /// The size of the image on the screen, in logical pixels
  final Size display;

  /// The part of it on the screen
  final Rect visible;
  final double devicePixelRatio;

  const _View(this.display, this.visible, this.devicePixelRatio);
}

enum _State { closed, opening, open, failed, disposed }

/// What an image is shown in tiles from: a local asset, or a remote image (downloaded to a file by the platform)
@immutable
class RegionSource {
  final String? localAssetId;
  final String? url;

  /// The pixels of the base, which tiles are not needed to show at its scale or smaller
  final double basePixels;

  const RegionSource({this.localAssetId, this.url, required this.basePixels})
    : assert((localAssetId == null) != (url == null));

  @override
  bool operator ==(Object other) =>
      other is RegionSource && other.localAssetId == localAssetId && other.url == url && other.basePixels == basePixels;

  @override
  int get hashCode => Object.hash(localAssetId, url, basePixels);
}

/// An image shown in tiles. It opens when it is [active] and tiles are needed, and notifies its listeners when tiles
/// arrive or it [failed].
class RegionImage extends ChangeNotifier {
  static final _log = Logger('RegionImage');
  static int _nextRequestId = 0;

  final RegionImageApi _api;
  final RegionSource source;

  RegionImage(this.source, {RegionImageApi? api}) : _api = api ?? RegionImageApi();

  String? get localAssetId => source.localAssetId;
  String? get url => source.url;
  double get basePixels => source.basePixels;

  _State _state = _State.closed;
  int? _openRequest;
  int? _id;
  int _width = 0;
  int _height = 0;

  // least recently shown first (a map keeps the order things were added)
  final _tiles = <_TileKey, _Tile>{};
  int _bytes = 0;
  final _pending = <_TileKey, int>{};
  final _broken = <_TileKey>{};
  _View? _view;
  bool _active = false;

  /// It cannot be shown in tiles (its format, or an error): the viewer decodes it whole, as before
  bool get failed => _state == _State.failed;

  /// Only the image on the screen opens and decodes; the others keep what they have
  set active(bool value) {
    if (_active == value) {
      return;
    }
    _active = value;
    if (!value) {
      _cancelPending();
    }
    _update();
  }

  /// What the screen shows: the image at [display] logical pixels, the part [visible] of it
  void show(Size display, Rect visible, double devicePixelRatio) {
    _view = _View(display, visible, devicePixelRatio);
    _update();
  }

  bool _needsTiles(_View view) {
    final display = view.display;
    if (display.isEmpty) {
      return false;
    }
    // pixels of the base for a logical pixel of the screen
    final base = math.sqrt(basePixels / (display.width * display.height));
    return base < view.devicePixelRatio;
  }

  int _sample(_View view) {
    final ratio = _width / (view.display.width * view.devicePixelRatio);
    var sample = 1;
    while (sample * 2 <= ratio) {
      sample *= 2;
    }
    return sample;
  }

  // the part on the screen, in pixels of the image
  Rect _visibleInImage(_View view) {
    final scale = _width / view.display.width;
    final visible = view.visible;
    return Rect.fromLTRB(
      visible.left * scale,
      visible.top * scale,
      visible.right * scale,
      visible.bottom * scale,
    ).intersect(Rect.fromLTWH(0, 0, _width.toDouble(), _height.toDouble()));
  }

  void _update() {
    final view = _view;
    if (!_active || view == null || _state == _State.failed || _state == _State.disposed) {
      return;
    }
    if (!_needsTiles(view)) {
      _cancelPending();
      return;
    }
    switch (_state) {
      case _State.closed:
        unawaited(_open());
        return;
      case _State.open:
        break;
      default:
        return;
    }

    final visible = _visibleInImage(view);
    if (visible.isEmpty) {
      _cancelPending();
      return;
    }
    final sample = _sample(view);
    final span = _kTileSize * sample;
    final wanted = <_TileKey>[];
    for (var row = visible.top ~/ span; row * span < visible.bottom; row++) {
      for (var column = visible.left ~/ span; column * span < visible.right; column++) {
        wanted.add(_TileKey(sample, column, row));
      }
    }
    // the middle of the screen first
    final center = visible.center;
    double distance(_TileKey key) =>
        (Offset((key.column + 0.5) * span, (key.row + 0.5) * span) - center).distanceSquared;
    wanted.sort((a, b) => distance(a).compareTo(distance(b)));

    final wantedSet = wanted.toSet();
    for (final key in _pending.keys.where((key) => !wantedSet.contains(key)).toList()) {
      _cancel(key);
    }
    for (final key in wanted) {
      final tile = _tiles.remove(key);
      if (tile != null) {
        _tiles[key] = tile;
      } else if (!_pending.containsKey(key) && !_broken.contains(key) && _pending.length < _kMaxPending) {
        unawaited(_decode(key));
      }
    }
  }

  Future<void> _open() async {
    _state = _State.opening;
    final requestId = _openRequest = _nextRequestId++;
    try {
      final result = await _api.open(localAssetId: localAssetId, url: url, requestId: requestId);
      _openRequest = null;
      if (result == null) {
        if (_state == _State.opening) {
          _state = _State.closed;
        }
        return;
      }
      final id = result['id']!;
      if (_state == _State.disposed) {
        unawaited(_api.close(id));
        return;
      }
      _id = id;
      _width = result['width']!;
      _height = result['height']!;
      // nothing more to see than in the base
      if (_width * _height <= basePixels) {
        _state = _State.failed;
        notifyListeners();
        return;
      }
      _state = _State.open;
      _update();
    } catch (error, stack) {
      _openRequest = null;
      if (_state == _State.disposed) {
        return;
      }
      _log.info('Cannot show ${localAssetId ?? url} in tiles: $error', error, stack);
      _state = _State.failed;
      notifyListeners();
    }
  }

  Future<void> _decode(_TileKey key) async {
    final span = _kTileSize * key.sample;
    final x = key.column * span;
    final y = key.row * span;
    final rect = Rect.fromLTWH(
      x.toDouble(),
      y.toDouble(),
      math.min(span, _width - x).toDouble(),
      math.min(span, _height - y).toDouble(),
    );
    final requestId = _nextRequestId++;
    _pending[key] = requestId;
    try {
      final result = await _api.decode(
        _id!,
        requestId: requestId,
        x: x,
        y: y,
        width: rect.width.toInt(),
        height: rect.height.toInt(),
        sample: key.sample,
      );
      if (result == null) {
        return;
      }
      final pointer = Pointer<Uint8>.fromAddress(result['pointer']!);
      if (_pending[key] != requestId || _state == _State.disposed) {
        malloc.free(pointer);
        return;
      }
      final image = await _toImage(pointer, result['width']!, result['height']!, result['rowBytes']!);
      if (_pending[key] != requestId || _state == _State.disposed) {
        image.dispose();
        return;
      }
      _pending.remove(key);
      _add(key, _Tile(image, rect, key.sample));
      notifyListeners();
    } catch (error, stack) {
      if (_pending[key] == requestId) {
        _log.warning('Cannot decode a tile of ${localAssetId ?? url}', error, stack);
        _broken.add(key);
      }
    } finally {
      if (_pending[key] == requestId) {
        _pending.remove(key);
      }
    }
    _update();
  }

  static Future<ui.Image> _toImage(Pointer<Uint8> pointer, int width, int height, int rowBytes) async {
    final ui.ImmutableBuffer buffer;
    try {
      buffer = await ui.ImmutableBuffer.fromUint8List(pointer.asTypedList(rowBytes * height));
    } finally {
      malloc.free(pointer);
    }
    final descriptor = ui.ImageDescriptor.raw(
      buffer,
      width: width,
      height: height,
      rowBytes: rowBytes,
      pixelFormat: ui.PixelFormat.rgba8888,
    );
    buffer.dispose();
    try {
      final codec = await descriptor.instantiateCodec();
      try {
        return (await codec.getNextFrame()).image;
      } finally {
        codec.dispose();
      }
    } finally {
      descriptor.dispose();
    }
  }

  void _add(_TileKey key, _Tile tile) {
    _tiles[key] = tile;
    _bytes += tile.bytes;
    // the tiles on the screen stay, even past the budget
    final view = _view;
    final visible = view == null ? Rect.zero : _visibleInImage(view);
    final sample = view == null ? 0 : _sample(view);
    final keys = _tiles.keys.toList();
    for (final old in keys) {
      if (_bytes <= _kCacheBytes) {
        break;
      }
      final oldTile = _tiles[old]!;
      if (old.sample == sample && oldTile.rect.overlaps(visible)) {
        continue;
      }
      _tiles.remove(old);
      _bytes -= oldTile.bytes;
      oldTile.image.dispose();
    }
  }

  void _cancel(_TileKey key) {
    final requestId = _pending.remove(key);
    if (requestId != null) {
      unawaited(_api.cancel(requestId));
    }
  }

  void _cancelPending() {
    for (final key in _pending.keys.toList()) {
      _cancel(key);
    }
  }

  /// Paints the tiles on the screen over the base, coarser ones first (they stand in for those not decoded yet)
  void paint(Canvas canvas, Size display) {
    final view = _view;
    if (view == null || _state != _State.open || !_needsTiles(view) || display.isEmpty) {
      return;
    }
    final visible = _visibleInImage(view);
    final scale = display.width / _width;
    final tiles = _tiles.values.where((tile) => tile.rect.overlaps(visible)).toList()
      ..sort((a, b) => b.sample.compareTo(a.sample));
    final paint = Paint()
      ..filterQuality = FilterQuality.medium
      ..isAntiAlias = false;
    for (final tile in tiles) {
      final image = tile.image;
      canvas.drawImageRect(
        image,
        Rect.fromLTWH(0, 0, image.width.toDouble(), image.height.toDouble()),
        Rect.fromLTRB(tile.rect.left * scale, tile.rect.top * scale, tile.rect.right * scale, tile.rect.bottom * scale),
        paint,
      );
    }
  }

  @override
  void dispose() {
    final state = _state;
    _state = _State.disposed;
    _cancelPending();
    final openRequest = _openRequest;
    if (state == _State.opening && openRequest != null) {
      unawaited(_api.cancel(openRequest));
    }
    final id = _id;
    if (id != null) {
      unawaited(_api.close(id));
    }
    for (final tile in _tiles.values) {
      tile.image.dispose();
    }
    _tiles.clear();
    super.dispose();
  }
}

/// The tiles of a [RegionImage], drawn over the base by PhotoView (its overlayBuilder), at the size the image is
/// shown. They are left out while the page comes in or goes away (the base flies in its Hero).
class RegionTiles extends StatefulWidget {
  final RegionImage image;
  final Size display;
  final Rect visible;

  const RegionTiles({super.key, required this.image, required this.display, required this.visible});

  @override
  State<RegionTiles> createState() => _RegionTilesState();
}

class _RegionTilesState extends State<RegionTiles> {
  Animation<double>? _routeAnimation;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final animation = ModalRoute.of(context)?.animation;
    if (animation != _routeAnimation) {
      _routeAnimation?.removeStatusListener(_onRouteStatus);
      _routeAnimation = animation?..addStatusListener(_onRouteStatus);
    }
    _show();
  }

  @override
  void didUpdateWidget(RegionTiles oldWidget) {
    super.didUpdateWidget(oldWidget);
    _show();
  }

  @override
  void dispose() {
    _routeAnimation?.removeStatusListener(_onRouteStatus);
    super.dispose();
  }

  void _onRouteStatus(AnimationStatus status) => setState(() {});

  void _show() => widget.image.show(widget.display, widget.visible, MediaQuery.devicePixelRatioOf(context));

  @override
  Widget build(BuildContext context) {
    final animation = _routeAnimation;
    if (animation != null && !animation.isCompleted) {
      return const SizedBox.shrink();
    }
    return IgnorePointer(
      child: CustomPaint(size: widget.display, painter: _RegionPainter(widget.image, widget.visible)),
    );
  }
}

class _RegionPainter extends CustomPainter {
  final RegionImage image;
  final Rect visible;

  _RegionPainter(this.image, this.visible) : super(repaint: image);

  @override
  void paint(Canvas canvas, Size size) => image.paint(canvas, size);

  @override
  bool shouldRepaint(_RegionPainter oldDelegate) => oldDelegate.image != image || oldDelegate.visible != visible;
}
