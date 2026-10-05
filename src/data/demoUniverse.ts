/**
 * Permascroll + EDL for the patent demo (US2012/0137202A1 FIGS.1–6)
 * Eleven source documents concatenated into one permascroll.
 */

import type { EditDecisionList, FlinkType } from '../zigzag/types'

const docs: { title: string; body: string }[] = [
  {
    title: 'Nelson Intro.txt',
    body: `Origins
How did all this get here? How did we? Where did the earth and the heavens come from? And people?

These must be obvious questions, because they have been answered over and over through the ages, with answers that have been many and varied. Some of the answers are called "religious," because they involve gods and myths, and some of the answers have been called "scientific," because they have been advanced by academics. But they have a lot in common.

The number of possible answers continues to grow with scientific progress and with the growth of new religions and their variants.

The origin of the universe is one thing, the origin of people is another. Somehow there came to be people on the earth; and most agree that the universe came first, before the people. But the Creation stories are very different.

The Fast Creation of the Universe and People
Western accounts begin with Bibles, the religious books begun by the Hebrews and extended by Christians. All the Bibles have a common account of a busy week when the universe, and the human race, were created by a God who somehow already existed.

The creation of the universe is described in the King James Bible like this:

01:001:001 IN THE BEGINNING GOD CREATED THE HEAVEN AND THE EARTH.
01:001:002 AND THE EARTH WAS WITHOUT FORM, AND VOID; AND DARKNESS WAS UPON THE FACE OF THE DEEP. AND THE SPIRIT OF GOD MOVED UPON THE FACE OF THE WATERS.
01:001:003 AND GOD SAID, LET THERE BE LIGHT: AND THERE WAS LIGHT.

God then goes on to make Eve, she and Adam are expelled from the Garden, they have sons who somehow meet other women and populate the earth.

There are interesting variants. For instance, in one of the Apocrypha ("The Alphabet of Ben Sira"), it is stated that the first woman is Lilith, who refuses to accept a sex-on-the-bottom position, and to whom Adam grants equality...

ADAM AND LILITH IMMEDIATELY BEGAN TO FIGHT. SHE SAID, "I WILL NOT LIE BELOW," AND HE SAID, "I WILL NOT LIE BENEATH YOU, BUT ONLY ON TOP. FOR YOU ARE FIT ONLY TO BE IN THE BOTTOM POSITION, WHILE I AM TO BE THE SUPERIOR ONE." LILITH RESPONDED, "WE ARE EQUAL TO EACH OTHER INASMUCH AS WE WERE BOTH CREATED FROM THE EARTH."

But equality is insufficient, and Lilith leaves quickly.

Of course, few educated people accept the six-day, Adam-and-Eve account today. It has become literature and myth, and even jokes.

The Flood
The different Bibles contain stories that were also kicking around separately in the ancient world. For example, we are all familiar with the story of Noah. But there are other accounts of a great and impossible flood that covered the world. The account of the Flood in the book of Genesis has a remarkable parallel to a story of the Flood in a Babylonian stone-tablet document.

We can consider the story of Noah, and the Assyrian story of the Flood, side by side. (We use floating links to show correspondences between the two accounts.)

In the Hebrew and Christian Bibles, it is the god Jehovah who gives the command to build the ark; in the Babylonian account, it is the god Shamash.

In both stories the ship is loaded with everything possible, including animals. Then comes the flood; and in both stories the hero releases a bird to see if the land has dried yet.

What Was The Origin Of The Universe?
Cosmology is the science of the physics of the universe, including its beginnings. There are many scientific theories of cosmology, but in a way they boil down to only two. Some say the universe has always been here, others say it somehow started. These are the two basic views: the steady state view and the Big Bang view.

Steady State
The steady-state theory of Fred Hoyle (also Bondi and Gold) says that the universe has always been pretty much the way it is, except that it continues to expand and matter flies away.

The Big Bang Theory
The Big Bang theory (a term coined by Fred Hoyle, who did not like the theory) takes the position that all matter and energy was created at one instant, and the universe has flown apart ever since.

Objectivity
Scientific "objectivity" is not what most people think. There are always biases. Religion (pro and con) continues to be a motivating force behind scientific theory. An example: physicist Georges Lemaitre, one of the originators of the Big Bang theory, had an implicit religious position. Whereas Fred Hoyle, the best-known exponent of the Steady-State theory, was protecting an atheistic position.

Art, too, can inspire science. Another non-scientific inspiration for the Steady-State theory came from a popular horror movie: THE STEADY STATE THEORY OF BONDI, GOLD AND HOYLE WAS INSPIRED BY THE CIRCULAR PLOT OF THE FILM DEAD OF NIGHT THEY WATCHED TOGETHER.
`,
  },
  {
    title: 'K.JamesCreation-cut.txt',
    body: `King James Bible, The Creation — Book 01 Genesis
01:001:001 In the beginning God created the heaven and the earth.
01:001:002 And the earth was without form, and void; and darkness was upon the face of the deep. And the Spirit of God moved upon the face of the waters.
01:001:003 And God said, Let there be light: and there was light.
01:001:004 And God saw the light, that it was good: and God divided the light from the darkness.
01:001:026 And God said, Let us make man in our image, after our likeness.
01:001:027 So God created man in his own image, in the image of God created he him; male and female created he them.
01:002:007 And the LORD God formed man of the dust of the ground, and breathed into his nostrils the breath of life; and man became a living soul.
01:002:018 And the LORD God said, It is not good that the man should be alone; I will make him an help meet for him.
01:002:21 And the LORD God caused a deep sleep to fall upon Adam, and he slept: and he took one of his ribs, and closed up the flesh instead thereof;
01:002:22 And the rib, which the LORD God had taken from man, made he a woman, and brought her unto the man.
`,
  },
  {
    title: 'K.JamesFlood-cut.txt',
    body: `King James Bible, The Flood
01:006:014 Make thee an ark of gopher wood; rooms shalt thou make in the ark, and shalt pitch it within and without with pitch.
01:006:017 And, behold, I, even I, do bring a flood of waters upon the earth, to destroy all flesh, wherein is the breath of life, from under heaven; and every thing that is in the earth shall die.
01:006:019 And of every living thing of all flesh, two of every sort shalt thou bring into the ark, to keep them alive with thee; they shall be male and female.
01:007:017 And the flood was forty days upon the earth; and the waters increased, and bare up the ark, and it was lift up above the earth.
01:008:007 And he sent forth a raven, which went forth to and fro, until the waters were dried up from off the earth.
01:008:008 Also he sent forth a dove from him, to see if the waters were abated from off the face of the ground;
01:008:011 And the dove came in to him in the evening; and, lo, in her mouth was an olive leaf pluckt off: so Noah knew that the waters were abated from off the earth.
`,
  },
  {
    title: 'Gilgamish Flood-cut.txt',
    body: `Gilgamish Epic, The Flood — Eleventh Tablet
Uta-Napishtim said unto him, to Gilgamish:
"I will reveal unto thee, O Gilgamish, a hidden mystery,
And a secret matter of the gods I will declare unto thee.
Shurippak, a city which thou thyself knowest,
On the bank of the river Puratti (Euphrates) is situated."

First Speech of Ea to Uta-Napishtim:
"O man of Shurippak, son of Ubara-Tutu,
Throw down the house, build a ship,
Forsake wealth, seek after life,
Abandon possessions, save thy life,
Carry grain of every kind into the ship."

The god Shamash had appointed me a time (saying)
The Power of Darkness will at eventide make a rain-flood to fall;
Then enter into the ship and shut thy door.

When the seventh day had come
I brought out a dove and let her go free.
The dove flew away and then came back;
Because she had no place to alight on she came back.
I brought out a raven and let her go free.
The raven flew away, she saw the sinking waters.
She ate, she pecked in the ground, she croaked, she came not back.
`,
  },
  {
    title: 'BenSira Lilith-cut.txt',
    body: `Excerpt from apocryphon, The Alphabet of Ben Sira
After God created Adam, who was alone, He said, It is not good for man to be alone. He then created a woman for Adam, from the earth, as He had created Adam himself, and called her Lilith. Adam and Lilith immediately began to fight. She said, 'I will not lie below,' and he said, 'I will not lie beneath you, but only on top. For you are fit only to be in the bottom position, while I am to be the superior one.' Lilith responded, 'We are equal to each other inasmuch as we were both created from the earth.' But they would not listen to one another. When Lilith saw this, she pronounced the Ineffable Name and flew away into the air.
`,
  },
  {
    title: 'DarwinDescentCh1-cut.txt',
    body: `From THE DESCENT OF MAN, Chapter 1, by Charles Darwin
Thus we can understand how it has come to pass that man and all other vertebrate animals have been constructed on the same general model, why they pass through the same early stages of development, and why they retain certain rudiments in common. Consequently we ought frankly to admit their community of descent: to take any other view, is to admit that our own structure, and that of all the animals around us, is a mere snare laid to entrap our judgment.
`,
  },
  {
    title: 'DeadOfNightRev-cut.txt',
    body: `Dead of Night — 1945 — review excerpt
It would be safe to say that most of the films on this site aren't particularly frightening. Dead of Night is different. Its final plot twist: its end is also its beginning, starting the story all over again. So the viewer, about to be relieved that the film is over, suddenly understands that it will never be over — thus perpetuating, in principle, the scariness. THE STEADY STATE THEORY OF BONDI, GOLD AND HOYLE WAS INSPIRED BY THE CIRCULAR PLOT OF THE FILM DEAD OF NIGHT THEY WATCHED TOGETHER.
`,
  },
  {
    title: 'LongBibleOrigins-cut.txt',
    body: `Excerpt from A History of Composition and Interpretation, by Dr. Thomas L. Long
Bibles are the products of centuries of theological and political struggle. In the most obvious sense, what Jews consider to be "the Bible" and what Christians consider to be "the Bible" are based on agreements about the role of Judaism in salvation history but disagreements about the significance of Jesus of Nazareth. Which texts are considered authoritative and divinely inspired (and therefore included in the Bible) is the question of the canon.
`,
  },
  {
    title: 'SchoolsBigBang-cut-FIX2.txt',
    body: `The Big Bang Theory — SchoolsObservatory.org.uk
Willem de Sitter was the first to show that the universe must expand. Georges Lemaitre, in 1927, thought about the consequences. He realised that an expanding universe would have been smaller yesterday than today and so on, all the way back to a day that would not have had a yesterday. He argued that that instant would have been the moment of creation, and as he was also an abbot of the Roman Catholic church argued that God had created a primeval atom which had grown to become the Universe. Fred Hoyle was unhappy about accepting a God-given creation, and as an atheist attempted to develop a theory without such an intervention. This was to become the steady state theory. In an attack on the theory he had dismissively referred to "this hot Big Bang" and the name stuck.
`,
  },
  {
    title: 'SchoolsSteadyState-cut.txt',
    body: `The Steady-State Theory — SchoolsObservatory.org.uk
An alternative theory to the Big Bang was proposed in 1948 by Hermann Bondi, Thomas Gold, and Sir Fred Hoyle. It was called the steady-state theory. They found the idea of a sudden beginning to the universe philosophically unsatisfactory. Hoyle approached the problem mathematically and tried to solve the problem of the creation of the matter seen all around us, which in the Big Bang theory is all created at the start. He proposed that the decrease in the density of the universe caused by its expansion is exactly balanced by the continuous creation of matter.
`,
  },
  {
    title: 'WpediaSteadyState-cut.txt',
    body: `Steady-state Theory — Wikipedia
The steady state theory of Bondi, Gold and Hoyle was inspired by the circular plot of the film Dead of Night they watched together. The steady state theory asserts that although the universe is expanding, it nevertheless does not change its look over time (the perfect cosmological principle); it has no beginning and no end. Chaotic inflation theory has many similarities with steady state theory, although on a much larger scale than originally envisaged. Alone among all cosmologies, the steady state model makes such definite predictions that it can be disproved even with the limited observational evidence at our disposal.
`,
  },
]

/** Build permascroll string and record start/size for each document */
function buildScroll(): {
  permascroll: string
  ranges: { title: string; start: number; size: number }[]
} {
  let permascroll = ''
  const ranges: { title: string; start: number; size: number }[] = []
  for (const d of docs) {
    const start = permascroll.length
    const chunk = `\n\n===== ${d.title} =====\n${d.body}`
    permascroll += chunk
    ranges.push({ title: d.title, start, size: chunk.length })
  }
  return { permascroll, ranges }
}

const { permascroll: PERMASCROLL, ranges } = buildScroll()

export { PERMASCROLL }

function loc(start: number, size: number) {
  return {
    fileId: 'Permascroll.txt',
    start,
    size,
  }
}

function findInScroll(snippet: string): { start: number; size: number } {
  const start = PERMASCROLL.indexOf(snippet)
  if (start < 0) {
    throw new Error(`Snippet not found in permascroll: ${snippet.slice(0, 40)}`)
  }
  return { start, size: snippet.length }
}

function flink(
  index: number,
  type: FlinkType,
  fromSnippet: string,
  toSnippet: string,
) {
  const from = findInScroll(fromSnippet)
  const to = findInScroll(toSnippet)
  return {
    index,
    type,
    from: [loc(from.start, from.size)],
    to: [loc(to.start, to.size)],
  }
}

/** Strand 0 = Nelson Intro (complex multi-block); others = one doc each */
export const DEMO_EDL: EditDecisionList = {
  permascrollFileId: 'Permascroll.txt',
  strands: [
    {
      index: 0,
      title: ranges[0].title,
      contents: [loc(ranges[0].start, ranges[0].size)],
    },
    ...ranges.slice(1).map((r, i) => ({
      index: i + 1,
      title: r.title,
      contents: [loc(r.start, r.size)],
    })),
  ],
  flinks: [
    flink(
      0,
      'correspondence',
      'IN THE BEGINNING GOD CREATED THE HEAVEN AND THE EARTH.',
      'In the beginning God created the heaven and the earth.',
    ),
    flink(
      1,
      'correspondence',
      'story of Noah, and the Assyrian story of the Flood',
      'Make thee an ark of gopher wood',
    ),
    flink(
      2,
      'correspondence',
      'god Shamash',
      'The god Shamash had appointed me a time',
    ),
    flink(
      3,
      'resemblance',
      'releases a bird to see if the land has dried yet',
      'I brought out a dove and let her go free',
    ),
    flink(
      4,
      'resemblance',
      'Alphabet of Ben Sira',
      'called her Lilith',
    ),
    flink(
      5,
      'comment',
      'community of descent',
      'admit their community of descent',
    ),
    flink(
      6,
      'pointer',
      'FILM DEAD OF NIGHT THEY WATCHED TOGETHER',
      'Dead of Night is different',
    ),
    flink(
      7,
      'disagreement',
      'steady state view and the Big Bang view',
      'this hot Big Bang',
    ),
    flink(
      8,
      'clash',
      'protecting an atheistic position',
      'Fred Hoyle was unhappy about accepting a God-given creation',
    ),
    flink(
      9,
      'bookmark',
      'Bibles have a common account',
      'Bibles are the products of centuries',
    ),
    flink(
      10,
      'resemblance',
      'continuous creation of matter',
      'continuous creation of matter',
    ),
    flink(
      11,
      'pointer',
      'inspired by the circular plot of the film Dead of Night',
      'inspired by the circular plot of the film Dead of Night they watched together',
    ),
    flink(
      12,
      'comment',
      'Chaotic inflation theory has many similarities with steady state theory',
      'Chaotic inflation theory has many similarities with steady state theory',
    ),
  ],
}

export const STRAND_TITLES = DEMO_EDL.strands.map((s) => s.title)
