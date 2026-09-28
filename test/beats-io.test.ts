import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildOsz, convertNotes, parseOsu, readBeatmapArchive, resolveCollisions, timingOf, writeOsu } from '../src/beats/osu';
import { readTags } from '../src/beats/tags';
import type { MapData, SongMeta } from '../src/beats/types';
import { parseDeezer, parseGoogleImages, parseItunes, parseYoutubeResults, splitArtistTitle, youtubeId } from '../src/beats/web';

const MANIA = `osu file format v14

[General]
AudioFilename: Audio.MP3
AudioLeadIn: 0
PreviewTime: 12345
Mode: 3
SampleSet: Soft

[Metadata]
Title:Test Song
TitleUnicode:テストソング
Artist:Tester
ArtistUnicode:テスター
Creator:mapper
Version:Hard 4K
Source:game
Tags:tag1 tag2
BeatmapID:123
BeatmapSetID:45

[Difficulty]
HPDrainRate:7
CircleSize:4
OverallDifficulty:8.5
ApproachRate:5
SliderMultiplier:1.4

[Events]
//Background and Video events
0,0,"BG.jpg",0,0
Video,-250,"clip.mp4"
2,5000,8000

[TimingPoints]
1000,500,4,2,1,70,1,0
9000,-50,4,2,2,60,0,0
13000,400,4,2,1,70,1,0

[HitObjects]
64,192,1000,1,0,0:0:0:0:
192,192,1500,1,0,0:0:0:80:Kick.wav
320,192,2000,128,0,2600:0:0:0:0:
448,192,2000,1,2,0:0:0:0:
64,192,10000,1,0,0:0:0:0:
`;

describe('osu! beatmaps', () => {
  it('parses a 4K osu!mania map', () => {
    const bm = parseOsu(MANIA);
    expect(bm.mode).toBe(3);
    expect(bm.keys).toBe(4);
    expect(bm.metadata.Title).toBe('Test Song');
    expect(bm.background).toBe('BG.jpg');
    expect(bm.video).toEqual({ file: 'clip.mp4', offset: -250 });
    expect(bm.breaks).toEqual([[5000, 8000]]);
    expect(timingOf(bm)).toEqual([{ t: 1, bpm: 120, meter: 4 }, { t: 13, bpm: 150, meter: 4 }]);
    const has = (n: string) => (n.toLowerCase() === 'kick.wav' ? 'kick.WAV' : n.toLowerCase() === 'soft-hitnormal2.wav' ? 'soft-hitnormal2.wav' : null);
    const { notes, converted } = convertNotes(bm, has);
    expect(converted).toBe(false);
    expect(notes.map((n) => [n.t, n.l])).toEqual([[1, 0], [1.5, 1], [2, 2], [2, 3], [10, 0]]);
    expect(notes[2].e).toBe(2.6);
    expect(notes[1].s).toBe('kick.WAV');
    expect(notes[1].v).toBe(0.8);
    // Sample index 2 from the inherited timing point → the beatmap's custom soft-hitnormal2.
    expect(notes[4].s).toBe('soft-hitnormal2.wav');
    expect(notes[0].s).toBeUndefined();
  });

  it('folds other key counts onto 4 lanes and converts osu!standard', () => {
    const seven = MANIA.replace('CircleSize:4', 'CircleSize:7').replace(/\[HitObjects\][\s\S]*/, `[HitObjects]\n${[0, 1, 2, 3, 4, 5, 6].map((c) => `${Math.floor((512 * (c + 0.5)) / 7)},192,${1000 + c * 100},1,0,0:0:0:0:`).join('\n')}\n36,192,3000,1,0,0:0:0:0:\n110,192,3000,1,0,0:0:0:0:\n`);
    const { notes, converted } = convertNotes(parseOsu(seven));
    expect(converted).toBe(true);
    expect(notes.slice(0, 7).map((n) => n.l)).toEqual([0, 0, 1, 1, 2, 2, 3]);
    // Two notes at 3000 ms in the same folded lane: one moves over.
    expect(notes.filter((n) => n.t === 3).map((n) => n.l).sort()).toEqual([0, 1]);

    const std = MANIA.replace('Mode: 3', 'Mode: 0').replace(/\[HitObjects\][\s\S]*/, `[HitObjects]\n40,100,1000,1,0,0:0:0:0:\n400,100,2000,2,0,B|450:100,1,140,0|0,0:0|0:0,0:0:0:0:\n256,192,4000,12,0,6000,0:0:0:0:\n`);
    const s = convertNotes(parseOsu(std)).notes;
    expect(s[0].l).toBe(0);
    expect(s[1].l).toBe(3);
    // 140 px at 1.4 × 100 px/beat = 1 beat = 500 ms.
    expect(s[1].e).toBeCloseTo(2.5, 3);
    expect(s[2].e).toBe(6);
  });

  it('resolves collisions and drops notes with no free lane', () => {
    const out = resolveCollisions([{ t: 1, l: 0 }, { t: 1, l: 0 }, { t: 1, l: 0 }, { t: 1, l: 0 }, { t: 1, l: 0 }]);
    expect(out.map((n) => n.l).sort()).toEqual([0, 1, 2, 3]);
  });

  it('reads an .osz with media, keysounds and several difficulties', () => {
    const easy = MANIA.replace('Version:Hard 4K', 'Version:Easy');
    const zip = zipSync({
      'Tester - Test Song (mapper) [Hard 4K].osu': strToU8(MANIA),
      'Tester - Test Song (mapper) [Easy].osu': strToU8(easy),
      'audio.mp3': new Uint8Array(100).fill(1),
      'bg.JPG': new Uint8Array(50).fill(2),
      'clip.mp4': new Uint8Array(70).fill(3),
      'Kick.wav': new Uint8Array(30).fill(4),
      'unused.png': new Uint8Array(10).fill(5),
    });
    const sets = readBeatmapArchive('set.osz', zip);
    expect(sets.length).toBe(1);
    const set = sets[0];
    expect(set.song.title).toBe('Test Song');
    expect(set.song.audio).toBe('audio.mp3');
    expect(set.song.background).toBe('bg.JPG');
    expect(set.song.video).toBe('clip.mp4');
    expect(set.song.videoOffset).toBe(-0.25);
    expect(set.song.previewTime).toBe(12.345);
    expect(set.song.bpm).toBe(120);
    expect(set.maps.map((m) => m.name).sort()).toEqual(['Easy', 'Hard 4K']);
    expect(set.maps[0].od).toBe(8.5);
    expect([...set.files.keys()].sort()).toEqual(['Kick.wav', 'audio.mp3', 'bg.JPG', 'clip.mp4']);
  });

  it('writes a 4K osu!mania map that reads back the same', () => {
    const song = { id: 's', title: 'Café', artist: 'Ärtist', source: 'file', previewTime: 20, duration: 60, bpm: 128, offset: 0.5, createdAt: '', maps: [], videoOffset: 0.1 } as SongMeta;
    const map = {
      id: 'm', songId: 's', name: 'Insane', description: 'fast', creator: 'me', level: 5, od: 8, hp: 7, origin: 'edited', createdAt: '', updatedAt: '',
      timing: [{ t: 0.5, bpm: 128, meter: 4 }],
      notes: [{ t: 1, l: 0 }, { t: 1.25, l: 3, e: 2 }, { t: 1.5, l: 2, s: 'clap.wav', v: 0.5 }],
    } as MapData;
    const text = writeOsu({ song, map, audioFile: 'audio.mp3', background: 'bg.jpg', video: 'video.mp4' });
    const bm = parseOsu(text);
    expect(bm.mode).toBe(3);
    expect(bm.keys).toBe(4);
    expect(bm.metadata.TitleUnicode).toBe('Café');
    expect(bm.metadata.Title).toBe('Caf');
    expect(bm.general.PreviewTime).toBe('20000');
    expect(bm.video).toEqual({ file: 'video.mp4', offset: 100 });
    expect(timingOf(bm)[0].bpm).toBeCloseTo(128, 6);
    const back = convertNotes(bm, (n) => n).notes;
    expect(back).toEqual([{ t: 1, l: 0 }, { t: 1.25, l: 3, e: 2 }, { t: 1.5, l: 2, s: 'clap.wav', v: 0.5 }]);
    const osz = buildOsz([{ name: 'x.osu', text }], new Map([['audio.mp3', new Uint8Array([1, 2, 3])]]));
    const files = unzipSync(osz);
    expect(Object.keys(files).sort()).toEqual(['audio.mp3', 'x.osu']);
  });
});

describe('YouTube and cover art parsing', () => {
  it('recognises YouTube links', () => {
    for (const u of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10', 'https://youtu.be/dQw4w9WgXcQ?si=x', 'youtube.com/shorts/dQw4w9WgXcQ', 'https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ', 'https://www.youtube.com/embed/dQw4w9WgXcQ']) {
      expect(youtubeId(u)).toBe('dQw4w9WgXcQ');
    }
    expect(youtubeId('https://soundcloud.com/a/b')).toBeNull();
  });

  it('reads search results from ytInitialData', () => {
    const data = {
      contents: {
        twoColumnSearchResultsRenderer: {
          primaryContents: {
            sectionListRenderer: {
              contents: [
                {
                  itemSectionRenderer: {
                    contents: [
                      { videoRenderer: { videoId: 'aaaaaaaaaaa', title: { runs: [{ text: 'Artist - Song (Official Video)' }] }, ownerText: { runs: [{ text: 'ArtistVEVO' }] }, lengthText: { simpleText: '3:45' }, viewCountText: { simpleText: '1,234,567 views' }, thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/aaaaaaaaaaa/hq720.jpg' }] } } },
                      { adSlotRenderer: {} },
                      { lockupViewModel: { contentId: 'bbbbbbbbbbb', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', contentImage: { thumbnailViewModel: { overlays: [{ thumbnailBottomOverlayViewModel: { badges: [{ thumbnailBadgeViewModel: { text: '1:02:03' } }] } }] } }, metadata: { lockupMetadataViewModel: { title: { content: 'Another' }, metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: 'Chan' } }, { text: { content: '2.5M views' } }] }] } } } } } },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    };
    const html = `<html><script>var ytInitialData = ${JSON.stringify(data)};</script><script>var foo = 1;</script></html>`;
    const r = parseYoutubeResults(html);
    expect(r.map((x) => [x.id, x.title, x.channel, x.duration, x.views])).toEqual([
      ['aaaaaaaaaaa', 'Artist - Song (Official Video)', 'ArtistVEVO', 225, 1234567],
      ['bbbbbbbbbbb', 'Another', 'Chan', 3723, 2500000],
    ]);
  });

  it('splits artist and title', () => {
    expect(splitArtistTitle('Daft Punk - One More Time (Official Video)')).toEqual({ artist: 'Daft Punk', title: 'One More Time' });
    expect(splitArtistTitle('Queen – Bohemian Rhapsody [Remastered 2011]')).toEqual({ artist: 'Queen', title: 'Bohemian Rhapsody' });
    expect(splitArtistTitle('some_track_name.mp3', 'Uploader - Topic')).toEqual({ artist: 'Uploader', title: 'some track name' });
    expect(splitArtistTitle('Song Title (Lyrics) | Big Channel', 'Chan')).toEqual({ artist: 'Chan', title: 'Song Title' });
  });

  it('finds the first Google Images result', () => {
    const html = `<div><img src="https://encrypted-tbn0.gstatic.com/images?q=tbn:ABC&amp;s=1"></div><script>AF_initDataCallback({data:[null,["https://encrypted-tbn0.gstatic.com/images?q\\u003dtbn:XYZ",225,225],["https://upload.example.org/covers/album.jpg",1200,1200],null,["https://cdn.example.com/b.png",800,600]]});</script>`;
    const urls = parseGoogleImages(html);
    expect(urls[0]).toBe('https://upload.example.org/covers/album.jpg');
    expect(urls[1]).toBe('https://cdn.example.com/b.png');
    expect(urls[urls.length - 1]).toBe('https://encrypted-tbn0.gstatic.com/images?q=tbn:ABC&s=1');
    expect(parseGoogleImages('<a href="/imgres?imgurl=https%3A%2F%2Fx.org%2Fa.jpg&amp;imgrefurl=y">')).toEqual(['https://x.org/a.jpg']);
  });

  it('reads iTunes and Deezer artwork', () => {
    expect(parseItunes({ results: [{ artworkUrl100: 'https://is1.mzstatic.com/image/thumb/x/100x100bb.jpg' }] })).toEqual(['https://is1.mzstatic.com/image/thumb/x/600x600bb.jpg']);
    expect(parseDeezer({ data: [{ album: { cover_xl: 'https://e-cdns-images.dzcdn.net/images/cover/1/1000x1000.jpg' } }] })).toEqual(['https://e-cdns-images.dzcdn.net/images/cover/1/1000x1000.jpg']);
  });
});

describe('embedded tags', () => {
  const frame = (id: string, body: number[]) => [...id].map((c) => c.charCodeAt(0)).concat([0, 0, (body.length >> 8) & 255, body.length & 255, 0, 0], body);
  const utf8 = (s: string) => [...new TextEncoder().encode(s)];

  it('reads ID3v2.3 title, artist and picture', () => {
    const jpeg = [0xff, 0xd8, ...new Array(200).fill(7)];
    const frames = [
      ...frame('TIT2', [3, ...utf8('Tïtle')]),
      ...frame('TPE1', [1, 0xff, 0xfe, ...[...'Me'].flatMap((c) => [c.charCodeAt(0), 0])]),
      ...frame('APIC', [0, ...utf8('image/jpeg'), 0, 3, ...utf8('cover'), 0, ...jpeg]),
    ];
    const size = frames.length;
    const header = [0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127];
    const t = readTags(new Uint8Array([...header, ...frames, 0xff, 0xfb]));
    expect(t.title).toBe('Tïtle');
    expect(t.artist).toBe('Me');
    expect(t.picture!.mime).toBe('image/jpeg');
    expect([...t.picture!.data.slice(0, 2)]).toEqual([0xff, 0xd8]);
  });

  it('reads FLAC vorbis comments', () => {
    const le = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];
    const comment = (s: string) => [...le(utf8(s).length), ...utf8(s)];
    const body = [...le(3), ...utf8('ven'), ...le(2), ...comment('TITLE=Flac Song'), ...comment('artist=Band')];
    const block = [0x84, (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255, ...body];
    const t = readTags(new Uint8Array([...utf8('fLaC'), ...block]));
    expect(t).toMatchObject({ title: 'Flac Song', artist: 'Band' });
  });

  it('reads MP4 ilst atoms', () => {
    const be = (n: number) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
    const atom = (type: string, body: number[]) => [...be(body.length + 8), ...[...type].map((c) => c.charCodeAt(0)), ...body];
    const data = (kind: number, payload: number[]) => atom('data', [...be(kind), 0, 0, 0, 0, ...payload]);
    const ilst = atom('ilst', [...atom('\xa9nam', data(1, utf8('M4A Song'))), ...atom('\xa9ART', data(1, utf8('Singer')))]);
    const meta = atom('meta', [0, 0, 0, 0, ...ilst]);
    const file = [...atom('ftyp', utf8('M4A isom')), ...atom('moov', atom('udta', meta))];
    expect(readTags(new Uint8Array(file))).toMatchObject({ title: 'M4A Song', artist: 'Singer' });
  });
});
