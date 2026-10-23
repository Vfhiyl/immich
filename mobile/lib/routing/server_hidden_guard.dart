import 'package:auto_route/auto_route.dart';
import 'package:immich_mobile/utils/url_helper.dart';

/// Keeps a phone signed in with a QR code off the pages that show the address of the server (logs, shared links):
/// their entries are hidden, and this covers any other way there
class ServerHiddenGuard extends AutoRouteGuard {
  const ServerHiddenGuard();
  @override
  Future<void> onNavigation(NavigationResolver resolver, StackRouter router) async {
    resolver.next(!isServerHidden());
  }
}
