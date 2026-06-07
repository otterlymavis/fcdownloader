import React from 'react';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { DownloadTask } from '../types';

interface Props {
  tasks: DownloadTask[];
  onCancel: (id: string) => void;
}

function getStatusText(task: DownloadTask): string {
  switch (task.status) {
    case 'pending':           return 'Starting…';
    case 'fetching_manifest': return 'Reading stream…';
    case 'assembling':        return 'Assembling file…';
    case 'downloading':
      return task.totalSegments > 0
        ? `Downloading  ${task.downloadedSegments} / ${task.totalSegments} parts`
        : 'Downloading…';
    default: return task.status;
  }
}

export default function DownloadProgressBar({ tasks, onCancel }: Props) {
  const dark = useColorScheme() === 'dark';
  const bg   = dark ? '#1C1C1E' : '#F2F2F7';
  const txt  = dark ? '#EBEBF5' : '#3C3C43';
  const trk  = dark ? '#3A3A3C' : '#D1D1D6';

  if (tasks.length === 0) return null;

  return (
    <View style={[styles.container, { backgroundColor: bg }]}>
      {tasks.map((task) => (
        <View key={task.id} style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.label, { color: txt }]}>{getStatusText(task)}</Text>
            <View style={[styles.track, { backgroundColor: trk }]}>
              <View style={[styles.fill, { width: `${Math.round(task.progress * 100)}%` as `${number}%` }]} />
            </View>
          </View>
          <Pressable hitSlop={14} onPress={() => onCancel(task.id)} style={styles.cancelBtn}>
            <Text style={styles.cancel}>✕</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 16, paddingVertical: 10 },
  row:       { flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 4 },
  label:     { fontSize: 13, marginBottom: 6, fontWeight: '500' },
  track:     { height: 4, borderRadius: 2, overflow: 'hidden' },
  fill:      { height: 4, backgroundColor: '#007AFF', borderRadius: 2 },
  cancelBtn: { padding: 4 },
  cancel:    { color: '#FF3B30', fontWeight: '700', fontSize: 16 },
});
