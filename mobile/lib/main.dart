import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';

import 'app_state.dart';
import 'core/store.dart';
import 'theme.dart';
import 'ui/home_page.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final dir = await getApplicationSupportDirectory();
  final store = Store(dir, KeystoreSecrets());
  await store.load();
  final app = AppState(store)..init();
  runApp(PultApp(app: app));
}

class PultApp extends StatelessWidget {
  const PultApp({super.key, required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: app.store,
      builder: (context, _) {
        final mode = switch (app.store.settings.theme) {
          'dark' => ThemeMode.dark,
          'light' => ThemeMode.light,
          _ => ThemeMode.system,
        };
        return MaterialApp(
          title: 'Pult',
          debugShowCheckedModeBanner: false,
          navigatorKey: app.navKey,
          themeMode: mode,
          theme: buildTheme(Pal.light),
          darkTheme: buildTheme(Pal.dark),
          builder: (context, child) {
            final p = context.pal;
            SystemChrome.setSystemUIOverlayStyle(SystemUiOverlayStyle(
              statusBarColor: Colors.transparent,
              statusBarIconBrightness: p.isDark ? Brightness.light : Brightness.dark,
              systemNavigationBarColor: p.bg,
              systemNavigationBarIconBrightness: p.isDark ? Brightness.light : Brightness.dark,
            ));
            return child!;
          },
          home: HomePage(app: app),
        );
      },
    );
  }
}
