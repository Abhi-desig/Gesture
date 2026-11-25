// A footage scene: your clip full frame, its voice-over and subtitle, and any
// explanation layered on top.
import { Audio, Video } from '@remotion/media';
import { AbsoluteFill, staticFile, useVideoConfig } from 'remotion';
import { VO_LEAD } from '../script';
import { FootageShade, Subtitle } from './Subtitle';

export const VoiceOver: React.FC<{ id: string; has: boolean }> = ({ id, has }) => {
  const { fps } = useVideoConfig();
  if (!has) return null;
  return <Audio src={staticFile(`voiceover/${id}.mp3`)} from={Math.round(VO_LEAD * fps)} name="Voice-over" />;
};

export const Footage: React.FC<{
  id: string;
  footage: string;
  vo: string;
  hasVo: boolean;
  children?: React.ReactNode;
}> = ({ id, footage, vo, hasVo, children }) => (
  <AbsoluteFill style={{ backgroundColor: 'black' }}>
    <Video src={staticFile(`footage/${footage}.mp4`)} muted objectFit="cover" style={{ width: '100%', height: '100%' }} name="Footage" />
    <FootageShade />
    {children}
    <Subtitle text={vo} />
    <VoiceOver id={id} has={hasVo} />
  </AbsoluteFill>
);
