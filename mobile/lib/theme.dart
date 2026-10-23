// Design tokens — the same palette as the desktop app: monochrome, one
// status colour at a time.

import 'package:flutter/material.dart';
import 'package:xterm/xterm.dart';

@immutable
class Pal extends ThemeExtension<Pal> {
  const Pal({
    required this.bg,
    required this.bg2,
    required this.bg3,
    required this.segOn,
    required this.hover,
    required this.active,
    required this.line,
    required this.line2,
    required this.fg,
    required this.fg2,
    required this.fg3,
    required this.accent,
    required this.accentFg,
    required this.ok,
    required this.warn,
    required this.err,
  });

  final Color bg, bg2, bg3, segOn, hover, active, line, line2;
  final Color fg, fg2, fg3, accent, accentFg, ok, warn, err;

  static const dark = Pal(
    bg: Color(0xFF0B0B0C),
    bg2: Color(0xFF141416),
    bg3: Color(0xFF151517),
    segOn: Color(0xFF242428),
    hover: Color(0x0BFFFFFF),
    active: Color(0x14FFFFFF),
    line: Color(0x12FFFFFF),
    line2: Color(0x1FFFFFFF),
    fg: Color(0xFFECECEE),
    fg2: Color(0xFFA1A1A8),
    fg3: Color(0xFF6A6A72),
    accent: Color(0xFFECECEE),
    accentFg: Color(0xFF0B0B0C),
    ok: Color(0xFF3ECF8E),
    warn: Color(0xFFF5B041),
    err: Color(0xFFF25C5F),
  );

  static const light = Pal(
    bg: Color(0xFFFFFFFF),
    bg2: Color(0xFFFFFFFF),
    bg3: Color(0xFFF5F5F6),
    segOn: Color(0xFFFFFFFF),
    hover: Color(0x0A000000),
    active: Color(0x11000000),
    line: Color(0x13000000),
    line2: Color(0x21000000),
    fg: Color(0xFF111113),
    fg2: Color(0xFF5F5F66),
    fg3: Color(0xFF9B9BA2),
    accent: Color(0xFF111113),
    accentFg: Color(0xFFFFFFFF),
    ok: Color(0xFF16A34A),
    warn: Color(0xFFC2780A),
    err: Color(0xFFDC3C42),
  );

  bool get isDark => bg.computeLuminance() < 0.5;

  @override
  Pal copyWith() => this;

  @override
  Pal lerp(Pal? other, double t) {
    if (other == null) return this;
    Color l(Color a, Color b) => Color.lerp(a, b, t)!;
    return Pal(
      bg: l(bg, other.bg),
      bg2: l(bg2, other.bg2),
      bg3: l(bg3, other.bg3),
      segOn: l(segOn, other.segOn),
      hover: l(hover, other.hover),
      active: l(active, other.active),
      line: l(line, other.line),
      line2: l(line2, other.line2),
      fg: l(fg, other.fg),
      fg2: l(fg2, other.fg2),
      fg3: l(fg3, other.fg3),
      accent: l(accent, other.accent),
      accentFg: l(accentFg, other.accentFg),
      ok: l(ok, other.ok),
      warn: l(warn, other.warn),
      err: l(err, other.err),
    );
  }
}

extension PalContext on BuildContext {
  Pal get pal => Theme.of(this).extension<Pal>()!;
}

const kMono = 'JetBrainsMono';
const kSans = 'Inter';

ThemeData buildTheme(Pal p) {
  final dark = p.isDark;
  final base = ThemeData(
    brightness: dark ? Brightness.dark : Brightness.light,
    useMaterial3: true,
    fontFamily: kSans,
    scaffoldBackgroundColor: p.bg,
    canvasColor: p.bg,
    splashFactory: NoSplash.splashFactory,
    highlightColor: p.hover,
    colorScheme: ColorScheme(
      brightness: dark ? Brightness.dark : Brightness.light,
      primary: p.accent,
      onPrimary: p.accentFg,
      secondary: p.fg2,
      onSecondary: p.bg,
      error: p.err,
      onError: Colors.white,
      surface: p.bg,
      onSurface: p.fg,
    ),
    extensions: [p],
  );
  return base.copyWith(
    textTheme: base.textTheme.apply(bodyColor: p.fg, displayColor: p.fg),
    dividerTheme: DividerThemeData(color: p.line, thickness: 1, space: 1),
    textSelectionTheme: TextSelectionThemeData(
      cursorColor: p.fg,
      selectionColor: p.fg.withValues(alpha: 0.18),
      selectionHandleColor: p.fg,
    ),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: p.bg2,
      surfaceTintColor: Colors.transparent,
      showDragHandle: true,
      dragHandleColor: p.line2,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: p.bg2,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18), side: BorderSide(color: p.line2)),
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: p.fg,
      contentTextStyle: TextStyle(fontFamily: kSans, color: p.bg, fontWeight: FontWeight.w500, fontSize: 13.5),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(999)),
      insetPadding: const EdgeInsets.fromLTRB(24, 0, 24, 18),
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(color: p.fg2, linearTrackColor: p.line2),
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? p.accentFg : Colors.white),
      trackColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? p.accent : p.line2),
      trackOutlineColor: const WidgetStatePropertyAll(Colors.transparent),
    ),
    checkboxTheme: CheckboxThemeData(
      fillColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? p.accent : Colors.transparent),
      checkColor: WidgetStatePropertyAll(p.accentFg),
      side: BorderSide(color: p.line2, width: 1.4),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(5)),
    ),
    popupMenuTheme: PopupMenuThemeData(
      color: p.bg2,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12), side: BorderSide(color: p.line2)),
      textStyle: TextStyle(fontFamily: kSans, color: p.fg, fontSize: 14),
    ),
  );
}

/* ---------------- terminal ---------------- */

TerminalTheme terminalTheme(Pal p) {
  if (p.isDark) {
    return const TerminalTheme(
      cursor: Color(0xFFE4E4E7),
      selection: Color(0x40FFFFFF),
      foreground: Color(0xFFE4E4E7),
      background: Color(0xFF0B0B0C),
      black: Color(0xFF27272A),
      red: Color(0xFFF87171),
      green: Color(0xFF4ADE80),
      yellow: Color(0xFFFACC15),
      blue: Color(0xFF60A5FA),
      magenta: Color(0xFFC084FC),
      cyan: Color(0xFF22D3EE),
      white: Color(0xFFD4D4D8),
      brightBlack: Color(0xFF63636B),
      brightRed: Color(0xFFFCA5A5),
      brightGreen: Color(0xFF86EFAC),
      brightYellow: Color(0xFFFDE68A),
      brightBlue: Color(0xFF93C5FD),
      brightMagenta: Color(0xFFD8B4FE),
      brightCyan: Color(0xFF67E8F9),
      brightWhite: Color(0xFFFAFAFA),
      searchHitBackground: Color(0x55FACC15),
      searchHitBackgroundCurrent: Color(0xFFFACC15),
      searchHitForeground: Color(0xFF0B0B0C),
    );
  }
  return const TerminalTheme(
    cursor: Color(0xFF18181B),
    selection: Color(0x33000000),
    foreground: Color(0xFF18181B),
    background: Color(0xFFFFFFFF),
    black: Color(0xFF18181B),
    red: Color(0xFFDC2626),
    green: Color(0xFF16A34A),
    yellow: Color(0xFFA16207),
    blue: Color(0xFF2563EB),
    magenta: Color(0xFF9333EA),
    cyan: Color(0xFF0E7490),
    white: Color(0xFF71717A),
    brightBlack: Color(0xFF52525B),
    brightRed: Color(0xFFEF4444),
    brightGreen: Color(0xFF22C55E),
    brightYellow: Color(0xFFCA8A04),
    brightBlue: Color(0xFF3B82F6),
    brightMagenta: Color(0xFFA855F7),
    brightCyan: Color(0xFF0891B2),
    brightWhite: Color(0xFFA1A1AA),
    searchHitBackground: Color(0x55CA8A04),
    searchHitBackgroundCurrent: Color(0xFFCA8A04),
    searchHitForeground: Color(0xFFFFFFFF),
  );
}
