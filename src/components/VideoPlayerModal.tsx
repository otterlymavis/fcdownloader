import React from 'react';
import {
  Modal,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
} from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';

interface Props {
  path: string;
  onClose: () => void;
}

/**
 * Mounts its own VideoPlayer instance so the player is always initialized
 * with a valid local URI — avoids passing null to useVideoPlayer.
 */
export default function VideoPlayerModal({ path, onClose }: Props) {
  const player = useVideoPlayer(path, (p) => {
    p.play();
  });

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.root}>
        <Pressable style={styles.closeBtn} onPress={onClose}>
          <Text style={styles.closeBtnText}>✕  Close</Text>
        </Pressable>
        <VideoView
          player={player}
          style={styles.video}
          fullscreenOptions={{ enable: true }}
          contentFit="contain"
          nativeControls
        />
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  closeBtn: { padding: 16 },
  closeBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  video: { flex: 1 },
});
