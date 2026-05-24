import React from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { ThemePref, FontSizePref, FONT_SCALE } from '../hooks/useSettings';

interface ThemeColors {
  dark: boolean;
  bg: string;
  card: string;
  card2: string;
  ink: string;
  ink2: string;
  ink3: string;
  sep: string;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  theme: ThemePref;
  fontSize: FontSizePref;
  onThemeChange: (v: ThemePref) => void;
  onFontSizeChange: (v: FontSizePref) => void;
  t: ThemeColors;
}

const IS_ANDROID = Platform.OS === 'android';
const BLUE = '#007AFF';
const S = { xs: 4, sm: 8, md: 16, lg: 24 } as const;
const R = { md: 12, lg: 14, sheet: 20 } as const;

const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light',  label: 'Light'  },
  { value: 'dark',   label: 'Dark'   },
];

const FONT_OPTIONS: { value: FontSizePref; label: string; preview: string }[] = [
  { value: 'small',  label: 'Small',  preview: 'Aa' },
  { value: 'medium', label: 'Medium', preview: 'Aa' },
  { value: 'large',  label: 'Large',  preview: 'Aa' },
];

export default function SettingsSheet({
  visible, onClose, theme, fontSize, onThemeChange, onFontSizeChange, t,
}: Props) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.sheet, { backgroundColor: t.bg }]}>
        <View style={[styles.handle, { backgroundColor: t.ink3 }]} />
        <Text style={[styles.title, { color: t.ink }]}>Settings</Text>

        <ScrollView showsVerticalScrollIndicator={false}>

          {/* ── Appearance ── */}
          <Text style={[styles.sectionLabel, { color: t.ink2 }]}>APPEARANCE</Text>
          <View style={[styles.card, { backgroundColor: t.card }]}>
            <Text style={[styles.rowLabel, { color: t.ink }]}>Theme</Text>
            <View style={styles.segmentRow}>
              {THEME_OPTIONS.map(({ value, label }) => {
                const active = theme === value;
                return (
                  <Pressable
                    key={value}
                    onPress={() => onThemeChange(value)}
                    style={[
                      styles.segment,
                      { backgroundColor: active ? BLUE : t.card2 },
                    ]}
                  >
                    <Text style={[styles.segmentLabel, { color: active ? '#fff' : t.ink2 }]}>
                      {label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* ── Text Size ── */}
          <Text style={[styles.sectionLabel, { color: t.ink2 }]}>TEXT SIZE</Text>
          <View style={[styles.card, { backgroundColor: t.card }]}>
            <Text style={[styles.rowLabel, { color: t.ink }]}>Font Size</Text>
            <View style={styles.segmentRow}>
              {FONT_OPTIONS.map(({ value, label, preview }) => {
                const active = fontSize === value;
                return (
                  <Pressable
                    key={value}
                    onPress={() => onFontSizeChange(value)}
                    style={[
                      styles.segment,
                      { backgroundColor: active ? BLUE : t.card2 },
                    ]}
                  >
                    <Text style={[
                      styles.fontPreview,
                      { color: active ? '#fff' : t.ink2, fontSize: 14 * FONT_SCALE[value] },
                    ]}>
                      {preview}
                    </Text>
                    <Text style={[styles.segmentLabel, { color: active ? '#fff' : t.ink2 }]}>
                      {label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* HD extractor section is hidden — backend URL + token are bundled
              at build time via EXPO_PUBLIC_EXTRACTOR_URL / _TOKEN. Power users
              can still override by writing the AsyncStorage keys directly. */}

        </ScrollView>

        <Pressable
          style={[styles.doneButton, { backgroundColor: t.card2 }]}
          onPress={onClose}
        >
          <Text style={[styles.doneLabel, { color: BLUE }]}>Done</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    borderTopLeftRadius: R.sheet,
    borderTopRightRadius: R.sheet,
    paddingBottom: IS_ANDROID ? 16 : 0,
    maxHeight: '70%',
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: S.sm,
    marginBottom: S.md,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: 0.3,
    paddingHorizontal: S.md,
    marginBottom: S.md,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.6,
    paddingHorizontal: S.md,
    marginBottom: S.xs,
    marginTop: S.sm,
  },
  card: {
    borderRadius: R.lg,
    marginHorizontal: S.md,
    marginBottom: S.sm,
    padding: S.md,
    gap: S.md,
  },
  rowLabel: {
    fontSize: 16,
    fontWeight: '500',
  },
  segmentRow: {
    flexDirection: 'row',
    gap: S.sm,
  },
  segment: {
    flex: 1,
    paddingVertical: S.sm,
    borderRadius: R.md,
    alignItems: 'center',
    justifyContent: 'center',
    gap: S.xs,
    minHeight: 44,
  },
  segmentLabel: {
    fontSize: 13,
    fontWeight: '600',
  },
  fontPreview: {
    fontWeight: '700',
    lineHeight: 18,
  },
  doneButton: {
    margin: S.md,
    paddingVertical: 14,
    borderRadius: R.lg,
    alignItems: 'center',
  },
  doneLabel: {
    fontSize: 16,
    fontWeight: '600',
  },
});
