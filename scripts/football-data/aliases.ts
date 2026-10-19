/**
 * football-data.co.uk team name -> API-Football team name, for names that differ.
 * Keys and values are lower case. Add entries per API-Football league id when a dry run
 * of import-football-data.ts lists team names it could not find.
 */
export const LEAGUE_ALIASES: Record<number, Record<string, string>> = {
  // Premier League
  39: {
    'man united': 'manchester united',
    'man city': 'manchester city',
    "nott'm forest": 'nottingham forest',
    'sheffield united': 'sheffield utd',
    spurs: 'tottenham',
    hull: 'hull city',
    wolverhampton: 'wolves',
    'leeds united': 'leeds',
    'leicester city': 'leicester',
    'ipswich town': 'ipswich',
    'luton town': 'luton',
  },
  // Championship
  40: {
    hull: 'hull city',
    oxford: 'oxford united',
    'sheffield united': 'sheffield utd',
    'sheffield weds': 'sheffield wednesday',
    stoke: 'stoke city',
  },
  // La Liga
  140: {
    'ath bilbao': 'athletic club',
    'ath madrid': 'atletico madrid',
    betis: 'real betis',
    celta: 'celta vigo',
    espanol: 'espanyol',
    granada: 'granada cf',
    'la coruna': 'deportivo la coruna',
    santander: 'racing santander',
    sociedad: 'real sociedad',
    vallecano: 'rayo vallecano',
  },
  // Serie A (Italy)
  135: {
    milan: 'ac milan',
    roma: 'as roma',
    verona: 'hellas verona',
  },
  // Bundesliga
  78: {
    augsburg: 'fc augsburg',
    'bayern munich': 'bayern münchen',
    bochum: 'vfl bochum',
    darmstadt: 'sv darmstadt 98',
    dortmund: 'borussia dortmund',
    'ein frankfurt': 'eintracht frankfurt',
    elversberg: 'sv elversberg',
    'fc koln': '1. fc köln',
    freiburg: 'sc freiburg',
    hamburg: 'hamburger sv',
    heidenheim: '1. fc heidenheim',
    hoffenheim: '1899 hoffenheim',
    leverkusen: 'bayer leverkusen',
    "m'gladbach": 'borussia mönchengladbach',
    mainz: 'fsv mainz 05',
    paderborn: 'sc paderborn 07',
    'schalke 04': 'fc schalke 04',
    'st pauli': 'fc st. pauli',
    stuttgart: 'vfb stuttgart',
    wolfsburg: 'vfl wolfsburg',
  },
  // Ligue 1
  61: {
    brest: 'stade brestois 29',
    clermont: 'clermont foot',
    'paris sg': 'paris saint germain',
    'st etienne': 'saint etienne',
    troyes: 'estac troyes',
  },
  // Eredivisie
  88: {
    'almere city': 'almere city fc',
    'den haag': 'ado den haag',
    'for sittard': 'fortuna sittard',
    nijmegen: 'nec nijmegen',
    volendam: 'fc volendam',
    zwolle: 'pec zwolle',
  },
  // Primeira Liga
  94: {
    guimaraes: 'vitória sc',
    porto: 'fc porto',
    'sp braga': 'sc braga',
    'sp lisbon': 'sporting cp',
  },
  // Süper Lig (accents are ignored when names are compared)
  203: {
    'ad. demirspor': 'adana demirspor',
    amedspor: 'amed',
    bodrumspor: 'bodrum fk',
    buyuksehyr: 'basaksehir',
    corum: 'corum fk',
    erzurumspor: 'erzurumspor fk',
    gaziantep: 'gaziantep fk',
    genclerbirligi: 'genclerbirligi s.k.',
    goztep: 'goztepe',
    karagumruk: 'fatih karagumruk',
  },
  // Jupiler Pro League
  144: {
    beveren: 'sk beveren',
    'club brugge': 'club brugge kv',
    eupen: 'as eupen',
    'lommel sk': 'lommel united',
    mechelen: 'kv mechelen',
    'oud-heverlee leuven': 'oh leuven',
    'rwd molenbeek': 'rwdm',
    'st truiden': 'st. truiden',
    'st. gilloise': 'union st. gilloise',
    standard: 'standard liege',
    waregem: 'zulte waregem',
    westerlo: 'kvc westerlo',
  },
  // Scottish Premiership
  179: {
    'dundee united': 'dundee utd',
    hearts: 'heart of midlothian',
  },
  // MLS
  253: {
    'atlanta utd': 'atlanta united fc',
    'austin fc': 'austin',
    'minnesota united': 'minnesota united fc',
    'new york city': 'new york city fc',
    'orlando city': 'orlando city sc',
    'san diego fc': 'san diego',
  },
  // Liga Profesional Argentina
  128: {
    'atl. tucuman': 'atletico tucuman',
    belgrano: 'belgrano cordoba',
    'central cordoba': 'central cordoba de santiago',
    'dep. riestra': 'deportivo riestra',
    'estudiantes rio cuarto': 'estudiantes de rio cuarto',
    'gimnasia mendoza': 'gimnasia m.',
    'ind. rivadavia': 'independ. rivadavia',
    instituto: 'instituto cordoba',
    'union de santa fe': 'union santa fe',
  },
  // Serie A (Brazil)
  71: {
    'america mg': 'america mineiro',
    'athletico-pr': 'atletico paranaense',
    'atletico go': 'atletico goianiense',
    'botafogo rj': 'botafogo',
    bragantino: 'rb bragantino',
    'flamengo rj': 'flamengo',
    fortaleza: 'fortaleza ec',
    vasco: 'vasco da gama',
  },
  // J1 League
  98: {
    chiba: 'jef united chiba',
    'hokkaido consadole sapporo': 'consadole sapporo',
    iwata: 'jubilo iwata',
    'kashima antlers': 'kashima',
    kyoto: 'kyoto sanga',
    machida: 'machida zelvia',
    mito: 'mito hollyhock',
    okayama: 'fagiano okayama',
    'urawa reds': 'urawa',
    verdy: 'tokyo verdy',
  },
  // Liga MX
  262: {
    'atl. san luis': 'atletico san luis',
    atlante: 'atlante fc',
    'club leon': 'leon',
    juarez: 'fc juarez',
    'mazatlan fc': 'mazatlan',
    pachuca: 'cf pachuca',
    queretaro: 'club queretaro',
    'unam pumas': 'u.n.a.m. - pumas',
  },
  // Allsvenskan
  113: {
    aik: 'aik stockholm',
    brommapojkarna: 'if brommapojkarna',
    degerfors: 'degerfors if',
    djurgarden: 'djurgardens if',
    elfsborg: 'if elfsborg',
    goteborg: 'ifk goteborg',
    hacken: 'bk hacken',
    hammarby: 'hammarby ff',
    kalmar: 'kalmar ff',
    landskrona: 'landskrona bois',
    mjallby: 'mjallby aif',
    norrkoping: 'ifk norrkoping',
    orgryte: 'orgryte is',
    oster: 'osters if',
    varberg: 'varbergs bois fc',
    varnamo: 'ifk varnamo',
    'vasteras sk': 'vasteras sk fk',
  },
  // Eliteserien
  103: {
    hamkam: 'ham-kam',
    kristiansund: 'kristiansund bk',
    odd: 'odd ballklubb',
    'sarpsborg 08': 'sarpsborg 08 ff',
  },
  // Ekstraklasa (ł and accents are ignored when names are compared)
  106: {
    cracovia: 'cracovia krakow',
    legia: 'legia warszawa',
    puszcza: 'puszcza niepolomice',
    rakow: 'rakow czestochowa',
    'termalica b-b.': 'nieciecza',
    wisla: 'wisla krakow',
    zaglebie: 'zaglebie lubin',
  },
};

/** Aliases that hold in every league. */
export const GLOBAL_ALIASES: Record<string, string> = {};

export function aliasesFor(leagueId: number): Record<string, string> {
  return { ...GLOBAL_ALIASES, ...LEAGUE_ALIASES[leagueId] };
}
