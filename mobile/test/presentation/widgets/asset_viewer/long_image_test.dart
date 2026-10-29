import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/presentation/widgets/asset_viewer/asset_page.widget.dart';

void main() {
  const phone = Size(360, 800);

  test('long screenshots are long images', () {
    expect(isLongImage(const Size(1080, 10000), phone), isTrue);
    expect(isLongImage(const Size(1080, 20000), phone), isTrue);
  });

  test('photos and screenshots of one screen are not', () {
    expect(isLongImage(const Size(3000, 4000), phone), isFalse);
    expect(isLongImage(const Size(1080, 2400), phone), isFalse);
    expect(isLongImage(const Size(16000, 1000), phone), isFalse);
  });

  test('it depends on the screen: a tall image on a wide screen', () {
    expect(isLongImage(const Size(1080, 3000), const Size(1200, 800)), isTrue);
    expect(isLongImage(const Size(1080, 3000), phone), isFalse);
  });

  test('without a size, nothing is long', () {
    expect(isLongImage(null, phone), isFalse);
    expect(isLongImage(const Size(1080, 20000), Size.zero), isFalse);
  });
}
