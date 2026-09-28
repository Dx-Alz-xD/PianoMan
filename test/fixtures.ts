export const wrap = (measures: string, extraParts = '', partList = '<score-part id="P1"><part-name>Piano</part-name></score-part>') => `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>Test Piece</work-title></work>
  <identification><creator type="composer">Tester</creator></identification>
  <part-list>${partList}</part-list>
  <part id="P1">${measures}</part>${extraParts}
</score-partwise>`;

export const note = (step: string, octave: number, dur: number, extra = '') =>
  `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${dur}</duration>${extra}</note>`;

export const attrs = (divisions = 1, beats = 4, beatType = 4, staves = 1) =>
  `<attributes><divisions>${divisions}</divisions><key><fifths>0</fifths></key><time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time>${
    staves > 1 ? `<staves>${staves}</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef>` : '<clef><sign>G</sign><line>2</line></clef>'
  }</attributes>`;
