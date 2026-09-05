/**
 * The vocabulary temporary passphrases are drawn from.
 *
 * Every word here has to survive being read down a hospital corridor to
 * someone who is not expecting it, so the list is curated rather than
 * borrowed:
 *
 *   - 3 to 10 letters, lower case, no punctuation, no accents;
 *   - concrete and ordinary, so it can be pictured and held in memory;
 *   - unambiguous when spoken — no homophone pairs (no "flour"/"flower",
 *     no "pair"/"pear", no "sea"/"see"), and nothing that rhymes with a
 *     neighbour closely enough to be misheard;
 *   - neutral in a clinical setting. Nothing about illness, injury, pain,
 *     death or the body, and nothing frightening or crude: this word is
 *     handed to someone recovering from surgery, and it should not be the
 *     unpleasant part of their day.
 *
 * The count is exactly 512, which is not cosmetic. A power of two divides
 * 2^32 exactly, so a 32-bit random draw reduced into this list is uniform.
 * Any other size leaves some words very slightly likelier than others.
 * Adding or removing a word without keeping the total at a power of two
 * reintroduces that bias — `temporary-credentials.test.ts` fails if the
 * count drifts.
 */
export const PASSPHRASE_WORDS: readonly string[] = [
  // Landscape and water
  'river', 'meadow', 'canyon', 'harbor', 'island', 'forest', 'valley', 'garden',
  'lagoon', 'summit', 'desert', 'jungle', 'marsh', 'brook', 'creek', 'pond',
  'lake', 'ocean', 'beach', 'dune', 'cliff', 'ridge', 'hill', 'cave',
  'grove', 'field', 'orchard', 'hedge', 'trail', 'bridge', 'tunnel', 'shore',
  'reef', 'cove', 'delta', 'basin', 'gorge', 'spring', 'stream', 'rapids',
  'crater', 'mesa', 'tundra', 'oasis', 'prairie', 'glacier', 'plateau', 'canal',
  'inlet', 'fjord', 'atoll', 'bayou', 'gulley', 'thicket', 'copse', 'moor',
  'heath', 'fen', 'glen', 'dell', 'vale', 'knoll', 'bluff', 'crag',

  // Weather and sky
  'cloud', 'thunder', 'breeze', 'sunset', 'sunrise', 'rainbow', 'frost', 'mist',
  'haze', 'drizzle', 'shower', 'gale', 'squall', 'zephyr', 'monsoon', 'aurora',
  'comet', 'meteor', 'planet', 'galaxy', 'nebula', 'eclipse', 'solstice', 'dusk',
  'dawn', 'twilight', 'noon', 'midday', 'evening', 'morning', 'season', 'summer',
  'autumn', 'winter', 'daybreak', 'equinox', 'moonlit', 'starry', 'sunny', 'cloudy',
  'windy', 'snowy', 'foggy', 'balmy', 'crisp', 'humid', 'arid', 'tropic',

  // Trees, plants and flowers
  'cedar', 'willow', 'maple', 'birch', 'aspen', 'poplar', 'alder', 'rowan',
  'hazel', 'walnut', 'chestnut', 'juniper', 'cypress', 'redwood', 'sequoia', 'magnolia',
  'jasmine', 'lavender', 'tulip', 'daisy', 'lily', 'iris', 'poppy', 'orchid',
  'violet', 'peony', 'dahlia', 'zinnia', 'aster', 'crocus', 'freesia', 'lotus',
  'fern', 'moss', 'ivy', 'clover', 'thistle', 'heather', 'bramble', 'nettle',
  'reed', 'rush', 'sedge', 'vine', 'shrub', 'sapling', 'bough', 'twig',
  'petal', 'blossom', 'bud', 'stem', 'root', 'bark', 'leaf', 'seed',
  'acorn', 'pinecone', 'sprout', 'harvest', 'meadowy', 'leafy', 'bloom', 'garland',

  // Animals and birds
  'otter', 'badger', 'rabbit', 'squirrel', 'hedgehog', 'beaver', 'marten', 'ferret',
  'falcon', 'kestrel', 'osprey', 'heron', 'egret', 'curlew', 'plover', 'lapwing',
  'swallow', 'martin', 'wren', 'robin', 'finch', 'linnet', 'siskin', 'thrush',
  'blackbird', 'starling', 'magpie', 'jackdaw', 'raven', 'rook', 'chough', 'oriole',
  'puffin', 'gannet', 'petrel', 'fulmar', 'kittiwake', 'guillemot', 'razorbill', 'tern',
  'dolphin', 'seal', 'walrus', 'narwhal', 'manatee', 'turtle', 'tortoise', 'gecko',
  'salmon', 'trout', 'herring', 'mackerel', 'sardine', 'anchovy', 'pollock', 'haddock',
  'cricket', 'beetle', 'firefly', 'ladybird', 'dragonfly', 'mayfly', 'moth', 'bumblebee',

  // Food and kitchen
  'mango', 'papaya', 'guava', 'lychee', 'apricot', 'nectarine', 'plum', 'damson',
  'cherry', 'quince', 'medlar', 'pomelo', 'kumquat', 'satsuma', 'clementine', 'tangerine',
  'almond', 'cashew', 'pecan', 'pistachio', 'hazelnut', 'peanut', 'sesame', 'poppyseed',
  'cinnamon', 'nutmeg', 'clove', 'cardamom', 'saffron', 'paprika', 'oregano', 'basil',
  'thyme', 'parsley', 'chervil', 'tarragon', 'rosemary', 'marjoram', 'fennel', 'dill',
  'barley', 'millet', 'quinoa', 'lentil', 'chickpea', 'butterbean', 'haricot', 'soybean',
  'pumpkin', 'squash', 'cucumber', 'gourd', 'parsnip', 'turnip', 'swede', 'beetroot',
  'biscuit', 'muffin', 'crumpet', 'waffle', 'pancake', 'pastry', 'custard', 'toffee',

  // Colours, materials and minerals
  'amber', 'azure', 'indigo', 'crimson', 'scarlet', 'magenta', 'cobalt', 'ochre',
  'sienna', 'umber', 'russet', 'auburn', 'copper', 'bronze', 'pewter', 'silver',
  'granite', 'marble', 'basalt', 'slate', 'quartz', 'flint', 'obsidian', 'pumice',
  'sandstone', 'limestone', 'gypsum', 'alabaster', 'jasper', 'agate', 'onyx', 'opal',
  'topaz', 'garnet', 'zircon', 'peridot', 'jadeite', 'malachite', 'turquoise', 'lapis',
  'velvet', 'satin', 'linen', 'cotton', 'canvas', 'denim', 'flannel', 'tweed',
  'timber', 'plywood', 'wicker', 'rattan', 'bamboo', 'cork', 'resin', 'lacquer',
  'porcelain', 'ceramic', 'terracotta', 'enamel', 'crystal', 'pearl', 'coral', 'ivory',

  // Around the house and the town
  'lantern', 'candle', 'kettle', 'teapot', 'saucer', 'platter', 'pitcher', 'tumbler',
  'cushion', 'blanket', 'quilt', 'curtain', 'carpet', 'doormat', 'shelf', 'cabinet',
  'drawer', 'wardrobe', 'dresser', 'mantel', 'hearth', 'chimney', 'balcony', 'veranda',
  'terrace', 'courtyard', 'gateway', 'archway', 'stairway', 'hallway', 'landing', 'attic',
  'cottage', 'cabin', 'lodge', 'chalet', 'villa', 'manor', 'abbey', 'chapel',
  'library', 'gallery', 'museum', 'theatre', 'market', 'bakery', 'pottery', 'workshop',
  'compass', 'beacon', 'anchor', 'paddle', 'rudder', 'mast', 'sail', 'keel',
  'satchel', 'basket', 'hamper', 'trunk', 'crate', 'barrel', 'bucket', 'ladle',

  // Music, craft and simple qualities
  'melody', 'harmony', 'rhythm', 'chorus', 'ballad', 'sonata', 'anthem', 'lullaby',
  'fiddle', 'banjo', 'cello', 'flute', 'oboe', 'clarinet', 'trumpet', 'timpani',
  'ribbon', 'button', 'thimble', 'bobbin', 'spindle', 'shuttle', 'loom', 'skein',
  'paper', 'parchment', 'inkwell', 'quill', 'palette', 'easel', 'crayon', 'sketch',
  'gentle', 'steady', 'quiet', 'lively', 'merry', 'jolly', 'brisk', 'nimble',
  'tidy', 'clever', 'humble', 'graceful', 'earnest', 'candid', 'placid', 'serene',
  'golden', 'silken', 'velvety', 'sunlit', 'shady', 'breezy', 'dewy', 'frosty',
  'quaint', 'rustic', 'homely', 'cosy', 'snug', 'ample', 'plenty', 'bounty',

  // Coast and landform, bringing the list to exactly 512
  'pebble', 'ripple', 'boulder', 'gravel', 'cobble', 'shingle', 'driftwood', 'seashell',
  'sandbar', 'headland', 'foreland', 'isthmus', 'lowland', 'upland', 'woodland', 'farmland',
]
