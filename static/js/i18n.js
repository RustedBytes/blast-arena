// English and Russian UI text. `t(key, params)` looks a string up in the
// current language; elements with data-i18n / data-i18n-placeholder /
// data-i18n-title attributes are translated by `applyI18n()`.

const STRINGS = {
  en: {
    tagline: 'One giant arena. Hundreds of players. Lots of bombs.',
    nickname: 'Your nickname',
    play: 'Play',
    language: 'Language',
    chooseArena: 'Choose an arena',
    arenaPlayers: '{n} playing',
    modeFfa: 'Free-for-all',
    modeTeams: 'Red vs Blue',
    profile: 'Your profile',
    level: 'Level {n}',
    xpProgress: '{xp} / {next} XP',
    profileStats: '{k} kills · {w} MVPs · best streak {s}',
    allTime: 'All-time top blasters',
    noRecords: 'No records yet. Be the first!',
    hat: 'Hat',
    trail: 'Trail',
    lockedAt: 'Unlocks at level {n}',
    hats: ['None', 'Cap', 'Party hat', 'Horns', 'Halo', 'Crown', 'Top hat'],
    trails: ['None', 'Gold sparks', 'Ice sparks', 'Rainbow'],
    helpMove: 'move', helpBomb: 'bomb', helpAct: 'action', helpZoom: 'zoom', helpMenu: 'settings',
    score: 'Score',
    topBlasters: 'Top blasters',
    online: '{n} online',
    holdTab: 'Hold {k} for details',
    roundLeft: 'Round ends in {t}',
    red: 'Red', blue: 'Blue',
    youBlewUp: 'You blew yourself up!',
    blastedBy: 'Blasted by {name}',
    youWereBlasted: 'You were blasted!',
    respawning: 'Respawning in {n}…',
    watching: 'Watching {name}',
    disconnected: 'Disconnected from server.',
    reconnecting: 'Connection lost. Reconnecting…',
    welcomeBack: 'Welcome back! Your progress was restored.',
    inviteCopied: 'Invite link copied!',
    invite: 'Invite a friend',
    wasBlasted: '{v} was blasted',
    blewUp: '{v} blew themselves up',
    streak: '{name} is on a {n}-kill streak!',
    bountyKill: 'Bounty claimed!',
    roundOver: 'Round over!',
    mvp: 'MVP',
    teamWins: '{team} team wins!',
    nextRound: 'Next round starts now',
    settings: 'Settings', music: 'Music', sfx: 'Sound effects', zoom: 'Zoom',
    mute: 'Mute all sound', showFps: 'Show FPS', colorblind: 'Colour-blind friendly colours',
    highContrast: 'High contrast', controls: 'Controls', powerups: 'Power-ups', back: 'Back to game',
    tutorialAgain: 'Show the tutorial again',
    ctlMove: 'Move (hold two keys to queue a turn)', ctlBomb: 'Drop bomb (again on it with line bomb)',
    ctlAct: 'Action: detonate remote bombs / punch', ctlZoom: 'Zoom in / out / reset', ctlBoard: 'Leaderboard details',
    ctlEmote: 'Emotes', ctlMenu: 'This menu',
    ctlPad: 'Stick / d-pad move, A bomb, X action, shoulders zoom', ctlTouch: 'Drag left side to steer, tap buttons, pinch to zoom',
    secretBox: 'Secret box: {what}',
    items: {
      1: '+1 bomb', 2: '+1 range', 3: 'Speed up', 4: 'Kick bombs', 5: 'Shield (6 s)', 6: 'Pierce crates',
      7: 'Max range', 8: 'Secret box', 9: 'Remote bombs (press E)', 10: 'Line bomb (bomb on your bomb)',
      11: 'Punch bombs (press E)', 12: 'Ghost: walk through crates',
      20: 'Jackpot! +1 bomb, range & speed', 30: 'Cursed: slowed down', 31: 'Cursed: no bombs',
      32: 'Bomb rain!', 33: 'Cursed: reversed controls',
    },
    curses: ['', 'Slowed', 'No bombs', 'Reversed'],
    emotes: ['Hi!', 'LOL', 'Grr!', 'Nice!', 'Boom!', 'Help!', 'GG', 'Cool'],
    tutorial: [
      ['Move around', 'Use WASD or the arrow keys (or drag on the left on a phone).'],
      ['Drop a bomb', 'Press Space, then get out of the cross-shaped blast!'],
      ['Grab power-ups', 'Blast crates to find power-ups. Purple boxes are secret boxes: a gamble!'],
      ['Win the round', 'Score by blasting others and standing on glowing hills. Wheel or pinch to zoom, Esc for settings.'],
    ],
    tutorialNext: 'Next', tutorialSkip: 'Skip tutorial', tutorialDone: "Let's go!",
    fullServer: 'server is full, try again later',
  },
  ru: {
    tagline: 'Одна огромная арена. Сотни игроков. Много бомб.',
    nickname: 'Ваш никнейм',
    play: 'Играть',
    language: 'Язык',
    chooseArena: 'Выберите арену',
    arenaPlayers: 'играют: {n}',
    modeFfa: 'Каждый сам за себя',
    modeTeams: 'Красные против синих',
    profile: 'Ваш профиль',
    level: 'Уровень {n}',
    xpProgress: '{xp} / {next} опыта',
    profileStats: 'убийств: {k} · MVP: {w} · лучшая серия: {s}',
    allTime: 'Лучшие за всё время',
    noRecords: 'Рекордов пока нет. Будьте первым!',
    hat: 'Шапка',
    trail: 'След',
    lockedAt: 'Откроется на уровне {n}',
    hats: ['Нет', 'Кепка', 'Колпак', 'Рога', 'Нимб', 'Корона', 'Цилиндр'],
    trails: ['Нет', 'Золотые искры', 'Ледяные искры', 'Радуга'],
    helpMove: 'движение', helpBomb: 'бомба', helpAct: 'действие', helpZoom: 'масштаб', helpMenu: 'настройки',
    score: 'Очки',
    topBlasters: 'Лучшие подрывники',
    online: 'онлайн: {n}',
    holdTab: 'Удерживайте {k} для деталей',
    roundLeft: 'До конца раунда {t}',
    red: 'Красные', blue: 'Синие',
    youBlewUp: 'Вы подорвали себя!',
    blastedBy: 'Вас взорвал {name}',
    youWereBlasted: 'Вас взорвали!',
    respawning: 'Возрождение через {n}…',
    watching: 'Наблюдаем за {name}',
    disconnected: 'Соединение с сервером потеряно.',
    reconnecting: 'Связь потеряна. Переподключение…',
    welcomeBack: 'С возвращением! Прогресс восстановлен.',
    inviteCopied: 'Ссылка-приглашение скопирована!',
    invite: 'Пригласить друга',
    wasBlasted: '{v} взорван',
    blewUp: '{v} подорвал себя',
    streak: '{name}: серия из {n} побед!',
    bountyKill: 'Награда за голову получена!',
    roundOver: 'Раунд окончен!',
    mvp: 'MVP',
    teamWins: 'Победа команды: {team}!',
    nextRound: 'Следующий раунд уже начался',
    settings: 'Настройки', music: 'Музыка', sfx: 'Звуки', zoom: 'Масштаб',
    mute: 'Выключить звук', showFps: 'Показывать FPS', colorblind: 'Цвета для дальтоников',
    highContrast: 'Высокий контраст', controls: 'Управление', powerups: 'Бонусы', back: 'Вернуться в игру',
    tutorialAgain: 'Показать обучение снова',
    ctlMove: 'Движение (удерживайте две клавиши, чтобы заранее повернуть)', ctlBomb: 'Бомба (ещё раз на ней — линия бомб)',
    ctlAct: 'Действие: подрыв пульта / удар по бомбе', ctlZoom: 'Приблизить / отдалить / сброс', ctlBoard: 'Подробная таблица',
    ctlEmote: 'Эмоции', ctlMenu: 'Это меню',
    ctlPad: 'Стик / крестовина — движение, A — бомба, X — действие, бамперы — масштаб', ctlTouch: 'Ведите слева для движения, нажимайте кнопки, щипок — масштаб',
    secretBox: 'Секретный ящик: {what}',
    items: {
      1: '+1 бомба', 2: '+1 к радиусу', 3: 'Ускорение', 4: 'Пинок бомб', 5: 'Щит (6 с)', 6: 'Пробивание ящиков',
      7: 'Максимальный радиус', 8: 'Секретный ящик', 9: 'Бомбы на пульте (E)', 10: 'Линия бомб (бомба на бомбе)',
      11: 'Удар по бомбам (E)', 12: 'Призрак: сквозь ящики',
      20: 'Джекпот! +1 бомба, радиус и скорость', 30: 'Проклятие: замедление', 31: 'Проклятие: нельзя ставить бомбы',
      32: 'Бомбовый дождь!', 33: 'Проклятие: управление наоборот',
    },
    curses: ['', 'Замедление', 'Без бомб', 'Наоборот'],
    emotes: ['Привет!', 'Ха-ха', 'Грр!', 'Класс!', 'Бум!', 'Помогите!', 'GG', 'Круто'],
    tutorial: [
      ['Двигайтесь', 'WASD или стрелки (на телефоне ведите пальцем слева).'],
      ['Поставьте бомбу', 'Нажмите пробел и уйдите из крестообразного взрыва!'],
      ['Собирайте бонусы', 'Взрывайте ящики, чтобы найти бонусы. Фиолетовые — секретные: риск!'],
      ['Выиграйте раунд', 'Очки за взрывы соперников и за стояние на светящихся холмах. Колесо или щипок — масштаб, Esc — настройки.'],
    ],
    tutorialNext: 'Далее', tutorialSkip: 'Пропустить', tutorialDone: 'Вперёд!',
    fullServer: 'сервер заполнен, попробуйте позже',
  },
};

export const LANGUAGES = { en: 'English', ru: 'Русский' };
let lang = 'en';

export function detectLanguage(saved) {
  if (saved && STRINGS[saved]) return saved;
  return (navigator.language || 'en').toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

export function setLanguage(l) {
  lang = STRINGS[l] ? l : 'en';
  document.documentElement.lang = lang;
  applyI18n();
}

export function getLanguage() {
  return lang;
}

/** A string (or nested value such as an array) in the current language. */
export function t(key, params) {
  let v = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
  if (params && typeof v === 'string') v = v.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? '');
  return v;
}

export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
}
