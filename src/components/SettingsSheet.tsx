import React from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { ThemePref, FontSizePref, LanguagePref, QualityPref, FONT_SCALE } from '../hooks/useSettings';
import { translate, TranslationKey } from '../constants/translations';
import { CommonLanguageCode } from '../lib/languageProfiles';

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
  visible?: boolean;
  onClose?: () => void;
  theme: ThemePref;
  fontSize: FontSizePref;
  language: LanguagePref;
  onThemeChange: (v: ThemePref) => void;
  onFontSizeChange: (v: FontSizePref) => void;
  onLanguageChange: (v: LanguagePref) => void;
  removeWatermark: boolean;
  onRemoveWatermarkChange: (v: boolean) => void;
  preferredQuality: QualityPref;
  onQualityChange: (v: QualityPref) => void;
  resolvedLanguage: CommonLanguageCode;
  t: ThemeColors;
  inline?: boolean;
}

const IS_ANDROID = Platform.OS === 'android';
const BLUE = '#007AFF';
const S = { xs: 4, sm: 8, md: 16, lg: 24 } as const;
const R = { md: 12, lg: 14, sheet: 20 } as const;

const THEME_OPTIONS: { value: ThemePref; labelKey: TranslationKey }[] = [
  { value: 'system', labelKey: 'system' },
  { value: 'light',  labelKey: 'light'  },
  { value: 'dark',   labelKey: 'dark'   },
];

const FONT_OPTIONS: { value: FontSizePref; labelKey: TranslationKey; preview: string }[] = [
  { value: 'small',  labelKey: 'small',  preview: 'Aa' },
  { value: 'medium', labelKey: 'medium', preview: 'Aa' },
  { value: 'large',  labelKey: 'large',  preview: 'Aa' },
];

const REMOVE_WATERMARK_NOTE =
  'Tries a clean source link first, then snapwc.com on supported sites. ' +
  'Leave this off to keep original media. Static image watermarks may remain.';

const QUALITY_OPTIONS: { value: QualityPref; label: string }[] = [
  { value: 'best',  label: 'Best' },
  { value: '2160p', label: '4K'   },
  { value: '1080p', label: '1080p' },
  { value: '720p',  label: '720p'  },
  { value: '480p',  label: '480p'  },
];

const LANGUAGE_OPTIONS: { value: LanguagePref; label: string; key?: TranslationKey }[] = [
  { value: 'system', label: 'Auto', key: 'auto' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'pt', label: 'Português' },
  { value: 'it', label: 'Italiano' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'zh', label: '简体中文' },
  { value: 'zh-hant', label: '繁體中文' },
  { value: 'hi', label: 'हिन्दी' },
  { value: 'ar', label: 'العربية' },
  { value: 'ru', label: 'Русский' },
];

export default function SettingsSheet({
  visible = false,
  onClose,
  theme,
  fontSize,
  language,
  onThemeChange,
  onFontSizeChange,
  onLanguageChange,
  removeWatermark,
  onRemoveWatermarkChange,
  preferredQuality,
  onQualityChange,
  resolvedLanguage,
  t,
  inline = false,
}: Props) {
  const isRTL = resolvedLanguage === 'ar';

  const content = (
    <View style={[styles.sheet, inline ? { flex: 1, maxHeight: undefined, paddingBottom: 0 } : { backgroundColor: t.bg }]}>
      {!inline && <View style={[styles.handle, { backgroundColor: t.ink3 }]} />}
      <Text style={[styles.title, { color: t.ink, textAlign: isRTL ? 'right' : 'left', marginTop: inline ? S.lg : 0 }]}>
        {translate('settings', resolvedLanguage)}
      </Text>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={inline && { paddingBottom: 100 }}>

        {/* ── Appearance ── */}
        <Text style={[styles.sectionLabel, { color: t.ink2, textAlign: isRTL ? 'right' : 'left' }]}>
          {translate('appearance', resolvedLanguage).toUpperCase()}
        </Text>
        <View style={[styles.card, { backgroundColor: t.card }]}>
          <Text style={[styles.rowLabel, { color: t.ink, textAlign: isRTL ? 'right' : 'left' }]}>
            {translate('theme', resolvedLanguage)}
          </Text>
          <View style={[styles.segmentRow, isRTL && { flexDirection: 'row-reverse' }]}>
            {THEME_OPTIONS.map(({ value, labelKey }) => {
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
                    {translate(labelKey, resolvedLanguage)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* ── Text Size ── */}
        <Text style={[styles.sectionLabel, { color: t.ink2, textAlign: isRTL ? 'right' : 'left' }]}>
          {translate('textSize', resolvedLanguage).toUpperCase()}
        </Text>
        <View style={[styles.card, { backgroundColor: t.card }]}>
          <Text style={[styles.rowLabel, { color: t.ink, textAlign: isRTL ? 'right' : 'left' }]}>
            {translate('fontSize', resolvedLanguage)}
          </Text>
          <View style={[styles.segmentRow, isRTL && { flexDirection: 'row-reverse' }]}>
            {FONT_OPTIONS.map(({ value, labelKey, preview }) => {
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
                    {translate(labelKey, resolvedLanguage)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* ── Language ── */}
        <Text style={[styles.sectionLabel, { color: t.ink2, textAlign: isRTL ? 'right' : 'left' }]}>
          {translate('language', resolvedLanguage).toUpperCase()}
        </Text>
        <View style={[styles.card, { backgroundColor: t.card }]}>
          <View style={[styles.langGrid, isRTL && { flexDirection: 'row-reverse' }]}>
            {LANGUAGE_OPTIONS.map(({ value, label, key }) => {
              const active = language === value;
              const displayText = key ? translate(key, resolvedLanguage) : label;
              return (
                <Pressable
                  key={value}
                  onPress={() => onLanguageChange(value)}
                  style={[
                    styles.langChip,
                    { backgroundColor: active ? BLUE : t.card2 },
                  ]}
                >
                  <Text style={[styles.langChipLabel, { color: active ? '#fff' : t.ink2 }]}>
                    {displayText}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* ── Downloads ── */}
        <Text style={[styles.sectionLabel, { color: t.ink2, textAlign: isRTL ? 'right' : 'left' }]}>
          DOWNLOADS
        </Text>
        <View style={[styles.card, { backgroundColor: t.card }]}>

          {/* Quality */}
          <Text style={[styles.rowLabel, { color: t.ink, textAlign: isRTL ? 'right' : 'left' }]}>
            {translate('quality', resolvedLanguage)}
          </Text>
          <View style={[styles.segmentRow, isRTL && { flexDirection: 'row-reverse' }]}>
            {QUALITY_OPTIONS.map(({ value, label }) => {
              const active = preferredQuality === value;
              return (
                <Pressable
                  key={value}
                  onPress={() => onQualityChange(value)}
                  style={[styles.segment, { backgroundColor: active ? BLUE : t.card2 }]}
                >
                  <Text style={[styles.segmentLabel, { color: active ? '#fff' : t.ink2 }]}>
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <View style={[styles.separator, { backgroundColor: t.sep }]} />

          {/* Remove Watermark */}
          <View style={[styles.toggleRow, isRTL && { flexDirection: 'row-reverse' }]}>
            <View style={styles.toggleText}>
              <Text style={[styles.rowLabel, { color: t.ink }]}>
                Remove Watermark
              </Text>
              <Text style={[styles.toggleNote, { color: t.ink3 }]}>
                {REMOVE_WATERMARK_NOTE}
              </Text>
            </View>
            <Switch
              value={removeWatermark}
              onValueChange={onRemoveWatermarkChange}
              trackColor={{ false: t.card2, true: BLUE }}
              thumbColor="#fff"
            />
          </View>
        </View>

      </ScrollView>

      {!inline && onClose && (
        <Pressable
          style={[styles.doneButton, { backgroundColor: t.card2 }]}
          onPress={onClose}
        >
          <Text style={[styles.doneLabel, { color: BLUE }]}>
            {translate('done', resolvedLanguage)}
          </Text>
        </Pressable>
      )}
    </View>
  );

  if (inline) {
    return content;
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      {content}
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    borderTopLeftRadius: R.sheet,
    borderTopRightRadius: R.sheet,
    paddingBottom: IS_ANDROID ? 16 : 0,
    maxHeight: '75%',
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
  langGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: S.sm,
  },
  langChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: R.md,
    minWidth: '28%',
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 40,
  },
  langChipLabel: {
    fontSize: 13,
    fontWeight: '600',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginVertical: S.xs,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: S.md,
  },
  toggleText: {
    flex: 1,
    gap: S.xs,
  },
  toggleNote: {
    fontSize: 12,
    lineHeight: 16,
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

