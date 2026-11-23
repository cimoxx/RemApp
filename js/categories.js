// Oddelenia obchodu. Kľúče sú stabilné (ukladajú sa do Sheets), názvy sa dajú kedykoľvek zmeniť.
import { normalize } from './util.js';

export const CATEGORIES = [
  { key: 'ovocie', label: 'Ovocie a zelenina', emoji: '🥕' },
  { key: 'pecivo', label: 'Pečivo', emoji: '🥖' },
  { key: 'mliecne', label: 'Mliečne', emoji: '🥛' },
  { key: 'maso', label: 'Mäso a údeniny', emoji: '🥩' },
  { key: 'mrazene', label: 'Mrazené', emoji: '🧊' },
  { key: 'trvanlive', label: 'Trvanlivé', emoji: '🥫' },
  { key: 'napoje', label: 'Nápoje', emoji: '🧃' },
  { key: 'drogeria', label: 'Drogéria', emoji: '🧴' },
  { key: 'domacnost', label: 'Domácnosť', emoji: '🧽' },
  { key: 'ine', label: 'Iné', emoji: '📦' }
];

export const DEFAULT_ORDER = CATEGORIES.map(c => c.key);
const BY_KEY = Object.fromEntries(CATEGORIES.map(c => [c.key, c]));

export const categoryOf = key => BY_KEY[key] || BY_KEY.ine;

/** Doplní chýbajúce a odstráni neznáme kľúče z uloženého poradia. */
export function normalizeOrder(order) {
  const seen = new Set();
  const out = [];
  for (const k of Array.isArray(order) ? order : []) {
    if (BY_KEY[k] && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  for (const k of DEFAULT_ORDER) if (!seen.has(k)) out.push(k);
  return out;
}

// Kmene slov bez diakritiky. Vyhráva najdlhší zhodný kmeň („mleta paprik“ > „paprik“).
const KEYWORDS = {
  ovocie: ['jablk', 'jablc', 'banan', 'hrusk', 'pomaranc', 'citron', 'limet', 'mandarin', 'grep', 'hrozn', 'jahod', 'malin',
    'cucoried', 'brusnic', 'ceresn', 'visn', 'broskyn', 'nektarin', 'marhul', 'slivk', 'kiwi', 'ananas', 'melon', 'mango',
    'avokad', 'datl', 'figy', 'paradajk', 'rajcin', 'cherry', 'uhork', 'paprik', 'cibul', 'cesnak', 'zemiak', 'batat', 'mrkv',
    'petrzlen', 'zeler', 'kapust', 'salat', 'rukol', 'spenat', 'brokolic', 'karfiol', 'kalerab', 'cuket', 'baklazan',
    'redkovk', 'tekvic', 'hokaido', 'sampinon', 'hriby', 'huby', 'bylink', 'bazalk', 'kopor', 'pazitk', 'fazulk', 'porek',
    'cvikl', 'repa', 'zelenin', 'ovoc', 'zazvor', 'klicky'],
  pecivo: ['chlieb', 'chleb', 'rozk', 'rozok', 'bagel', 'baget', 'croissant', 'kroasan', 'pecivo', 'vianock', 'buchta',
    'buchty', 'kolac', 'toastov', 'zeml', 'kaiserk', 'pagac', 'osie hniezd', 'tortil', 'lepenk', 'stangl', 'pletenk', 'donut',
    'muffin', 'strudl', 'langos', 'babovk', 'knedl', 'chlebik'],
  mliecne: ['mliek', 'mlieko', 'jogurt', 'syr', 'syry', 'tvaroh', 'smotan', 'maslo', 'bryndz', 'kefir', 'acidk', 'zakys',
    'mozzarell', 'parmez', 'eidam', 'gouda', 'niva', 'hermelin', 'cottage', 'mascarpon', 'ricott', 'feta', 'halloumi', 'vajc',
    'vajic', 'puding', 'skyr', 'lucin', 'termix', 'ostiepok', 'korbacik', 'parenic', 'mliecn', 'ayran', 'cmar'],
  maso: ['maso', 'masa', 'kurac', 'kuraci', 'kurca', 'bravc', 'hovadz', 'teleci', 'jahnac', 'mlete', 'mleteho', 'salam',
    'sunk', 'slanin', 'parky', 'parok', 'klobas', 'spekacik', 'rezen', 'steak', 'krkovic', 'karé', 'kare', 'rebierk',
    'stehn', 'prsia', 'pecen', 'ryba', 'ryby', 'losos', 'pstruh', 'kapor', 'treska', 'krevet', 'filet', 'morc', 'kacic',
    'hus', 'hydin', 'pastet', 'tlacenk', 'jaternic', 'hurk', 'udenin', 'udene', 'prosciutt', 'chorizo', 'pancett', 'gyros',
    'kebab', 'cevap'],
  mrazene: ['mrazen', 'zmrzlin', 'nanuk', 'hranolk', 'pizza', 'pizze', 'ladov', 'kocky lad', 'zmes zelenin', 'rybie prsty',
    'pirohy', 'listov'],
  trvanlive: ['cestovin', 'spaget', 'penne', 'fusilli', 'lasagn', 'rezance', 'ryza', 'ryze', 'kuskus', 'bulgur', 'quinoa',
    'muka', 'muky', 'krupic', 'cukor', 'cukr', 'sol ', 'sol', 'olej', 'ocot', 'octu', 'konzerv', 'fazul', 'sosovic', 'cicer',
    'hrach', 'kukuric', 'tuniak', 'sardin', 'kecup', 'horcic', 'majonez', 'tatarsk', 'dresing', 'korenie', 'mleta paprik',
    'cierne koren', 'oregano', 'skoric', 'vanilk', 'caj', 'kava', 'kakao', 'cokolad', 'susienk', 'keks', 'oplatk', 'tycink',
    'cips', 'chips', 'lupienk', 'slane', 'orech', 'mandl', 'arasid', 'kesu', 'hrozienk', 'musli', 'ovsen', 'vlock', 'cornflak',
    'med', 'dzem', 'lekvar', 'nutell', 'natierk', 'polievk', 'bujon', 'omack', 'drozdi', 'prasok do peciva', 'kypriaci',
    'zelatin', 'sirup', 'kompot', 'olivy', 'nakladan', 'kyslu kapust', 'pyre', 'strukovin', 'protein'],
  napoje: ['voda', 'vody', 'mineralk', 'sodovk', 'dzus', 'dzusy', 'nektar', 'limonad', 'kofol', 'cola', 'fanta', 'sprite',
    'tonic', 'pivo', 'piva', 'vino', 'vina', 'prosecco', 'sekt', 'sampan', 'rum', 'vodk', 'gin', 'whisk', 'borovick',
    'slivovic', 'hruskovic', 'likér', 'liker', 'energetick', 'ladovy caj', 'smoothie', 'mlieko ovsene', 'radler', 'cider'],
  drogeria: ['sampon', 'mydl', 'zubn', 'kefk', 'dezodor', 'antiperspir', 'sprchov', 'krem', 'balzam', 'toaletny papier',
    'toaletak', 'plienk', 'vlhcen', 'vatov', 'tampon', 'vlozk', 'holiac', 'zilet', 'parfum', 'pletov', 'kondicion', 'lak na',
    'gel na', 'vitamin', 'opalovac', 'lieky', 'naplast', 'odlicov', 'zubna nit', 'ustna voda', 'kozmetik',
    'hygien', 'farba na vlasy', 'rasenk', 'mydlo', 'papierove vreckovk', 'vreckovk'],
  domacnost: ['praci', 'prasok na pran', 'avivaz', 'saponat', 'cistiac', 'cistic', 'savo', 'wc ', 'sacky', 'vrecia', 'vreck na',
    'alobal', 'potravinov', 'folia', 'papierove utierk', 'utierk', 'servitk', 'hubk', 'handr', 'mop', 'baterie', 'ziarovk',
    'zarovk', 'sviecky', 'sviecka', 'tablety do umyvack', 'umyvack', 'kapsul', 'osviezovac', 'odvapnovac', 'rukavic',
    'zapalovac', 'zapalk', 'kvetin', 'krmivo', 'granule', 'podstielk', 'dazdnik', 'lepiaca pask', 'vrecka na odpad', 'odpad']
};

const ENTRIES = Object.entries(KEYWORDS)
  .flatMap(([cat, stems]) => stems.map(s => [normalize(s), cat]))
  .sort((a, b) => b[0].length - a[0].length);

/** Odhad oddelenia pre novú položku bez histórie. */
export function guessCategory(name) {
  const n = ` ${normalize(name)} `;
  for (const [stem, cat] of ENTRIES) {
    // kmeň musí začínať na začiatku slova („syr“ v „syrovy“, ale nie v „masyra“)
    if (n.includes(' ' + stem)) return cat;
  }
  return 'ine';
}
