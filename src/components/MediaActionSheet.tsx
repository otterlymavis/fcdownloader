import React from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';
import { DetectedMedia } from '../types';

interface Props {
  visible: boolean;
  items: DetectedMedia[];
  mseActive: boolean;
  onClose: () => void;
  onDownload: (item: DetectedMedia) => void;
  onHandoff: (item: DetectedMedia) => void;
}

export default function MediaActionSheet({
  visible,
  items,
  mseActive,
  onClose,
  onDownload,
  onHandoff,
}: Props) {
  const dark = useColorScheme() === 'dark';
  const c = dark ? D : L;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose} />

      <View style={[styles.sheet, c.sheet]}>
        <View style={[styles.handle, c.handle]} />

        <Text style={[styles.title, c.text]}>Detected Media</Text>

        {mseActive && items.length === 0 && (
          <View style={[styles.mseBanner, c.mseBanner]}>
            <Text style={[styles.mseBannerText, c.subtext]}>
              MSE / Blob stream detected on this page. Navigate to a direct
              .m3u8 or .mpd URL to enable downloading.
            </Text>
          </View>
        )}

        <ScrollView style={{ maxHeight: 420 }} showsVerticalScrollIndicator={false}>
          {items.map((item) => (
            <View key={item.id} style={[styles.row, c.row]}>
              <View style={{ flex: 1, gap: 4 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text
                    style={[
                      styles.badge,
                      item.mediaType === 'hls' ? styles.hlsBadge : styles.dashBadge,
                    ]}
                  >
                    {(item.mediaKind ?? item.mediaType).toUpperCase()}
                  </Text>
                  {item.label ? (
                    <Text style={[styles.label, c.text]}>{item.label}</Text>
                  ) : null}
                </View>
                <Text style={[styles.url, c.subtext]} numberOfLines={2}>
                  {item.url}
                </Text>
                <Text style={[styles.pageMeta, c.subtext]} numberOfLines={1}>
                  {item.pageUrl}
                </Text>
              </View>

              <View style={styles.actions}>
                <Pressable
                  style={styles.btnPrimary}
                  onPress={() => {
                    onDownload(item);
                    onClose();
                  }}
                >
                  <Text style={styles.btnPrimaryText}>Save</Text>
                </Pressable>
                <Pressable
                  style={[styles.btnSecondary, c.btnSecondary]}
                  onPress={() => {
                    onHandoff(item);
                    onClose();
                  }}
                >
                  <Text style={styles.btnSecondaryText}>Open in…</Text>
                </Pressable>
              </View>
            </View>
          ))}

          {items.length === 0 && !mseActive && (
            <Text style={[styles.empty, c.subtext]}>
              Browse to a page with media. Items are detected
              automatically when the page requests them.
            </Text>
          )}
        </ScrollView>

        <Pressable style={[styles.closeRow, c.closeRow]} onPress={onClose}>
          <Text style={[styles.closeText, c.text]}>Close</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 16,
    paddingBottom: 32,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 14,
  },
  title: { fontSize: 17, fontWeight: '600', marginBottom: 10 },
  mseBanner: { borderRadius: 10, padding: 12, marginBottom: 10 },
  mseBannerText: { fontSize: 13, lineHeight: 18 },
  row: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  badge: {
    alignSelf: 'flex-start',
    fontSize: 10,
    fontWeight: '800',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 5,
    overflow: 'hidden',
    color: '#fff',
  },
  hlsBadge: { backgroundColor: '#0a84ff' },
  dashBadge: { backgroundColor: '#30d158' },
  label: { fontSize: 13, fontWeight: '600' },
  url: { fontSize: 12, lineHeight: 16 },
  pageMeta: { fontSize: 11, opacity: 0.6 },
  actions: { flexDirection: 'row', gap: 8, alignSelf: 'flex-end' },
  btnPrimary: {
    backgroundColor: '#0a84ff',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 9,
  },
  btnPrimaryText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  btnSecondary: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 9,
    borderWidth: 1,
  },
  btnSecondaryText: { color: '#0a84ff', fontWeight: '600', fontSize: 13 },
  empty: { textAlign: 'center', padding: 32, fontSize: 14, lineHeight: 20 },
  closeRow: {
    marginTop: 16,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  closeText: { fontWeight: '600', fontSize: 16 },
});

const D = StyleSheet.create({
  sheet: { backgroundColor: '#1c1c1e' },
  handle: { backgroundColor: '#48484a' },
  text: { color: '#ffffff' },
  subtext: { color: '#ababab' },
  row: { borderBottomColor: '#3a3a3c' },
  mseBanner: { backgroundColor: '#2c2c2e' },
  btnSecondary: { borderColor: '#0a84ff' },
  closeRow: { backgroundColor: '#2c2c2e' },
});

const L = StyleSheet.create({
  sheet: { backgroundColor: '#ffffff' },
  handle: { backgroundColor: '#c7c7cc' },
  text: { color: '#000000' },
  subtext: { color: '#6d6d72' },
  row: { borderBottomColor: '#e5e5ea' },
  mseBanner: { backgroundColor: '#f2f2f7' },
  btnSecondary: { borderColor: '#0a84ff' },
  closeRow: { backgroundColor: '#f2f2f7' },
});
