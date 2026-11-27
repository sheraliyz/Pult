// Design tokens — the same "device" look as the desktop app (styles.css): a
// light chassis with physical keys, a black screen for the terminal,
// dot-matrix numerals and one signal colour. Key colours carry meaning:
// signal = the main action or the chosen mode, ink (black) = where you are,
// grey = helpers. At night the same device comes in graphite.

import 'package:flutter/material.dart';
import 'package:xterm/xterm.dart';

const kMono = 'JetBrainsMono';
const kSans = 'Geist';
const kDot = 'Doto';

/// Signal colours offered in the settings (same as the desktop app).
const signalSwatches = <String, Color>{
  'orange': Color(0xFFFF5A1F),
  'yellow': Color(0xFFFFC21A),
  'blue': Color(0xFF3D7BFF),
  'green': Color(0xFF2BD47D),
};

/// Chassis tints for the light theme: (body, rail).
const bodySwatches = <String, (Color, Color)>{
  'gray': (Color(0xFFE2E1DB), Color(0xFFD6D5CF)),
  'mint': (Color(0xFFD9E3DA), Color(0xFFCDD7CE)),
  'sky': (Color(0xFFD8E1EA), Color(0xFFCCD5DE)),
  'sand': (Color(0xFFE9DCCB), Color(0xFFDDD0BF)),
};

@immutable
class Pal extends ThemeExtension<Pal> {
  const Pal({
    required this.dark,
    required this.body,
    required this.rail,
    required this.paper,
    required this.input,
    required this.well,
    required this.key,
    required this.key2,
    required this.ink,
    required this.ink2,
    required this.ink3,
    required this.ink4,
    required this.onInk,
    required this.stroke,
    required this.keyShadow,
    required this.line,
    required this.line2,
    required this.hover,
    required this.active,
    required this.signal,
    required this.onSignal,
    required this.ok,
    required this.warn,
    required this.err,
    required this.screen,
    required this.bezel,
    required this.screenRing,
  });

  final bool dark;
  // chassis
  final Color body, rail, paper, input, well, key, key2;
  // ink
  final Color ink, ink2, ink3, ink4, onInk, stroke, keyShadow, line, line2, hover, active;
  // signal
  final Color signal, onSignal;
  // states
  final Color ok, warn, err;
  // the terminal screen (black in both themes)
  final Color screen, bezel, screenRing;

  factory Pal.light({String signal = 'orange', String body = 'gray'}) {
    final b = bodySwatches[body] ?? bodySwatches['gray']!;
    return Pal(
      dark: false,
      body: b.$1,
      rail: b.$2,
      paper: const Color(0xFFF7F6F2),
      input: const Color(0xFFFFFFFF),
      well: const Color(0xFFE8E7E1),
      key: const Color(0xFFF4F4F1),
      key2: const Color(0xFFA9AAA4),
      ink: const Color(0xFF121314),
      ink2: const Color(0xFF2E3135),
      ink3: const Color(0xFF45484C),
      ink4: const Color(0xFF6B6E72),
      onInk: const Color(0xFFF4F4F1),
      stroke: const Color(0xFF121314),
      keyShadow: const Color(0xFF121314),
      line: const Color(0x24121314),
      line2: const Color(0x3D121314),
      hover: const Color(0x0F121314),
      active: const Color(0x1A121314),
      signal: signalSwatches[signal] ?? signalSwatches['orange']!,
      onSignal: const Color(0xFF121314),
      ok: const Color(0xFF15803D),
      warn: const Color(0xFFB45309),
      err: const Color(0xFFB42318),
      screen: const Color(0xFF0A0A0B),
      bezel: const Color(0xFF121314),
      screenRing: const Color(0xFF26272A),
    );
  }

  factory Pal.night({String signal = 'orange'}) => Pal(
        dark: true,
        body: const Color(0xFF121314),
        rail: const Color(0xFF0D0E0F),
        paper: const Color(0xFF1A1B1D),
        input: const Color(0xFF121314),
        well: const Color(0xFF232427),
        key: const Color(0xFF1E1F22),
        key2: const Color(0xFF303236),
        ink: const Color(0xFFECECE8),
        ink2: const Color(0xFFC9CAC5),
        ink3: const Color(0xFFA3A5A8),
        ink4: const Color(0xFF75787C),
        onInk: const Color(0xFF121314),
        stroke: const Color(0xFF3A3C40),
        keyShadow: const Color(0xFF000000),
        line: const Color(0x1FECECE8),
        line2: const Color(0x33ECECE8),
        hover: const Color(0x0FECECE8),
        active: const Color(0x1AECECE8),
        signal: signalSwatches[signal] ?? signalSwatches['orange']!,
        onSignal: const Color(0xFF121314),
        ok: const Color(0xFF6EE7A0),
        warn: const Color(0xFFFBBF5A),
        err: const Color(0xFFFF8A7A),
        screen: const Color(0xFF0A0A0B),
        bezel: const Color(0xFF000000),
        screenRing: const Color(0xFF222326),
      );

  // The names the screens were written with.
  bool get isDark => dark;
  Color get bg => body;
  Color get bg2 => paper;
  Color get bg3 => well;
  Color get segOn => key;
  Color get fg => ink;
  Color get fg2 => ink2;
  Color get fg3 => ink3;
  Color get accent => ink;
  Color get accentFg => onInk;

  @override
  Pal copyWith() => this;

  @override
  Pal lerp(Pal? other, double t) {
    if (other == null) return this;
    Color l(Color a, Color b) => Color.lerp(a, b, t)!;
    return Pal(
      dark: t < 0.5 ? dark : other.dark,
      body: l(body, other.body),
      rail: l(rail, other.rail),
      paper: l(paper, other.paper),
      input: l(input, other.input),
      well: l(well, other.well),
      key: l(key, other.key),
      key2: l(key2, other.key2),
      ink: l(ink, other.ink),
      ink2: l(ink2, other.ink2),
      ink3: l(ink3, other.ink3),
      ink4: l(ink4, other.ink4),
      onInk: l(onInk, other.onInk),
      stroke: l(stroke, other.stroke),
      keyShadow: l(keyShadow, other.keyShadow),
      line: l(line, other.line),
      line2: l(line2, other.line2),
      hover: l(hover, other.hover),
      active: l(active, other.active),
      signal: l(signal, other.signal),
      onSignal: l(onSignal, other.onSignal),
      ok: l(ok, other.ok),
      warn: l(warn, other.warn),
      err: l(err, other.err),
      screen: l(screen, other.screen),
      bezel: l(bezel, other.bezel),
      screenRing: l(screenRing, other.screenRing),
    );
  }
}

extension PalContext on BuildContext {
  Pal get pal => Theme.of(this).extension<Pal>()!;
}

/// Dot-matrix numerals (Doto), as on the desktop status bar.
TextStyle dotStyle(double size, {Color? color}) => TextStyle(fontFamily: kDot, fontWeight: FontWeight.w900, fontSize: size, height: 1, color: color, letterSpacing: 0.2);

/// Readouts glanced at all the time (status row: ping, CPU, limits): a plain,
/// heavy mono — the dot-matrix face stays for the large numbers.
TextStyle readoutStyle(double size, {Color? color}) =>
    TextStyle(fontFamily: kMono, fontWeight: FontWeight.w700, fontSize: size, height: 1, color: color, fontFeatures: const [FontFeature.tabularFigures()]);

/// Small uppercase labels on keys and chips ("PING", "CPU", "SERVERLAR").
TextStyle capsStyle(Color color, {double size = 11}) => TextStyle(fontFamily: kSans, fontSize: size, fontWeight: FontWeight.w700, letterSpacing: 0.7, color: color);

ThemeData buildTheme(Pal p) {
  final dark = p.isDark;
  final base = ThemeData(
    brightness: dark ? Brightness.dark : Brightness.light,
    useMaterial3: true,
    fontFamily: kSans,
    scaffoldBackgroundColor: p.body,
    canvasColor: p.body,
    splashFactory: NoSplash.splashFactory,
    highlightColor: p.hover,
    colorScheme: ColorScheme(
      brightness: dark ? Brightness.dark : Brightness.light,
      primary: p.ink,
      onPrimary: p.onInk,
      secondary: p.signal,
      onSecondary: p.onSignal,
      error: p.err,
      onError: Colors.white,
      surface: p.body,
      onSurface: p.ink,
    ),
    extensions: [p],
  );
  final keyBorder = BorderSide(color: p.stroke, width: 1.4);
  return base.copyWith(
    textTheme: base.textTheme.apply(bodyColor: p.ink, displayColor: p.ink),
    dividerTheme: DividerThemeData(color: p.line, thickness: 1, space: 1),
    textSelectionTheme: TextSelectionThemeData(
      cursorColor: p.ink,
      selectionColor: p.signal.withValues(alpha: 0.35),
      selectionHandleColor: p.signal,
    ),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: p.paper,
      surfaceTintColor: Colors.transparent,
      showDragHandle: true,
      dragHandleColor: p.line2,
      shape: RoundedRectangleBorder(borderRadius: const BorderRadius.vertical(top: Radius.circular(22)), side: keyBorder),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: p.paper,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18), side: keyBorder),
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: p.ink,
      contentTextStyle: TextStyle(fontFamily: kSans, color: p.onInk, fontWeight: FontWeight.w500, fontSize: 14),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      insetPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(color: p.signal, linearTrackColor: p.line2, circularTrackColor: Colors.transparent),
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? p.input : p.key),
      trackColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? p.signal : p.key2),
      trackOutlineColor: WidgetStatePropertyAll(p.stroke),
      trackOutlineWidth: const WidgetStatePropertyAll(1.4),
    ),
    checkboxTheme: CheckboxThemeData(
      fillColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? p.ink : p.input),
      checkColor: WidgetStatePropertyAll(p.onInk),
      side: BorderSide(color: p.stroke, width: 1.4),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
    ),
    popupMenuTheme: PopupMenuThemeData(
      color: p.paper,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12), side: keyBorder),
      textStyle: TextStyle(fontFamily: kSans, color: p.ink, fontSize: 14.5),
    ),
    tooltipTheme: TooltipThemeData(
      decoration: BoxDecoration(color: p.ink, borderRadius: BorderRadius.circular(8)),
      textStyle: TextStyle(fontFamily: kSans, color: p.onInk, fontSize: 12.5, fontWeight: FontWeight.w500),
    ),
    appBarTheme: AppBarTheme(
      backgroundColor: p.body,
      foregroundColor: p.ink,
      surfaceTintColor: Colors.transparent,
      scrolledUnderElevation: 0,
      elevation: 0,
      titleTextStyle: TextStyle(fontFamily: kSans, color: p.ink, fontSize: 18, fontWeight: FontWeight.w700),
    ),
  );
}

/* ---------------- terminal ---------------- */

/// The screen is black in both themes (as on the desktop); the cursor wears
/// the signal colour.
TerminalTheme terminalTheme(Pal p) => TerminalTheme(
      cursor: p.signal,
      selection: const Color(0x55FFFFFF),
      foreground: const Color(0xFFE6E6E3),
      background: p.screen,
      black: const Color(0xFF27272A),
      red: const Color(0xFFF87171),
      green: const Color(0xFF4ADE80),
      yellow: const Color(0xFFFACC15),
      blue: const Color(0xFF60A5FA),
      magenta: const Color(0xFFC084FC),
      cyan: const Color(0xFF22D3EE),
      white: const Color(0xFFD4D4D8),
      brightBlack: const Color(0xFF71717A),
      brightRed: const Color(0xFFFCA5A5),
      brightGreen: const Color(0xFF86EFAC),
      brightYellow: const Color(0xFFFDE68A),
      brightBlue: const Color(0xFF93C5FD),
      brightMagenta: const Color(0xFFD8B4FE),
      brightCyan: const Color(0xFF67E8F9),
      brightWhite: const Color(0xFFFAFAFA),
      searchHitBackground: const Color(0x55FACC15),
      searchHitBackgroundCurrent: const Color(0xFFFACC15),
      searchHitForeground: const Color(0xFF0A0A0B),
    );
