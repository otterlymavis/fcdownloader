import React from 'react';
import { Text, StyleProp, TextStyle } from 'react-native';

// Unicode characters that render as monochrome text and respect `color` style.
// Replaces @expo/vector-icons / Ionicons — no native font dependency.
const GLYPHS: Record<string, string> = {
  'alert':             '⚠', // ⚠
  'bookmark':          '★', // ★
  'bookmark-outline':  '☆', // ☆
  'checkmark':         '✓', // ✓
  'chevron-back':      '←', // ←
  'chevron-forward':   '→', // →
  'close':             '✕', // ✕
  'download':          '↓', // ↓
  'download-outline':  '↓', // ↓
  'globe':             '⊕', // ⊕
  'globe-outline':     '⊕', // ⊕
  'home':              '⌂', // ⌂
  'home-outline':      '⌂', // ⌂
  'play':              '▶', // ▶
  'refresh':           '↻', // ↻
  'scan-outline':      '⊟', // ⊟
  'search-outline':    '⌕', // ⌕
  'settings':          '⚙', // ⚙
  'settings-outline':  '⚙', // ⚙
  'trash-outline':     '✖', // ✖
};

interface Props {
  name: keyof typeof GLYPHS;
  size: number;
  color: string;
  style?: StyleProp<TextStyle>;
}

export default function Icon({ name, size, color, style }: Props) {
  return (
    <Text
      style={[{ fontSize: size, color, lineHeight: size * 1.2, includeFontPadding: false }, style]}
      selectable={false}
    >
      {GLYPHS[name] ?? '?'}
    </Text>
  );
}
