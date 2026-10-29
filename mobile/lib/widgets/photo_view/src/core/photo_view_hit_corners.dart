import 'package:flutter/widgets.dart';
import 'package:immich_mobile/widgets/photo_view/src/controller/photo_view_controller_delegate.dart'
    show PhotoViewControllerDelegate;

mixin HitCornersDetector on PhotoViewControllerDelegate {
  HitCorners _hitCornersX() {
    final double childWidth = scaleBoundaries.childSize.width * scale;
    final double screenWidth = scaleBoundaries.outerSize.width;
    if (screenWidth - childWidth > -0.001) {
      return const HitCorners(true, true);
    }
    // the position is within cornersX: at its max the child shows its left edge, at its min its right edge (with a
    // centred child the range is symmetric, so comparing -position as before gave the same; not for other alignments)
    final x = position.dx;
    final cornersX = this.cornersX();
    return HitCorners(x >= cornersX.max, x <= cornersX.min);
  }

  HitCorners _hitCornersY() {
    final double childHeight = scaleBoundaries.childSize.height * scale;
    final double screenHeight = scaleBoundaries.outerSize.height;
    if (screenHeight - childHeight > -0.001) {
      return const HitCorners(true, true);
    }
    // as for x: at the max the child shows its top, at the min its bottom
    final y = position.dy;
    final cornersY = this.cornersY();
    return HitCorners(y >= cornersY.max, y <= cornersY.min);
  }

  bool _shouldMoveAxis(HitCorners hitCorners, double mainAxisMove) {
    if (mainAxisMove == 0) {
      return false;
    }
    if (!hitCorners.hasHitAny) {
      return true;
    }
    final axisBlocked = hitCorners.hasHitBoth || (hitCorners.hasHitMax ? mainAxisMove > 0 : mainAxisMove < 0);
    if (axisBlocked) {
      return false;
    }
    return true;
  }

  bool _shouldMoveX(Offset move) {
    final hitCornersX = _hitCornersX();
    final mainAxisMove = move.dx;

    return _shouldMoveAxis(hitCornersX, mainAxisMove);
  }

  bool _shouldMoveY(Offset move) {
    final hitCornersY = _hitCornersY();
    final mainAxisMove = move.dy;

    return _shouldMoveAxis(hitCornersY, mainAxisMove);
  }

  bool shouldMove(Offset move, Axis mainAxis) {
    if (mainAxis == Axis.vertical) {
      return _shouldMoveY(move);
    }
    return _shouldMoveX(move);
  }
}

class HitCorners {
  const HitCorners(this.hasHitMin, this.hasHitMax);

  final bool hasHitMin;
  final bool hasHitMax;

  bool get hasHitAny => hasHitMin || hasHitMax;

  bool get hasHitBoth => hasHitMin && hasHitMax;
}
