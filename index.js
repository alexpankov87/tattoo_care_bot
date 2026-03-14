const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const express = require('express');
const serverless = require('serverless-http');
require('dotenv').config();

// Инициализация бота
const bot = new Telegraf(process.env.BOT_TOKEN);
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // должен быть задан в окружении

// Создаём Express-приложение
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Бот работает');
});

// Глобальный объект для хранения кэша и логов
const systemCache = {
  // Кэш данных
  userList: null,
  questionList: null,
  stats: null,
  lastUpdated: null,
  
  // Логи системы
  systemLogs: [],
  maxLogs: 1000, // Максимальное количество хранимых логов
  
  // Лог действий администратора
  actionLog: []
};

// Переменные для управления рассылкой
const broadcastState = {
  isActive: false,
  currentAdminId: null,
  messageText: null,
  totalUsers: 0,
  successCount: 0,
  failedCount: 0,
  startTime: null,
  endTime: null
};



// Функция для безопасного добавления логов
function addToSystemLog(message, type = 'INFO') {
  const logEntry = {
    timestamp: new Date(),
    type: type,
    message: message,
    pid: process.pid
  };
  
  systemCache.systemLogs.push(logEntry);
  
  // Ограничиваем размер логов
  if (systemCache.systemLogs.length > systemCache.maxLogs) {
    systemCache.systemLogs.shift(); // Удаляем самый старый лог
  }
  
  // Также выводим в консоль для отладки
  const time = logEntry.timestamp.toLocaleTimeString('ru-RU');
  const logMessage = `[${time}] ${type}: ${message}`;
  
  // Используем оригинальный console.log без переопределения
  const originalConsole = console.log.bind(console);
  originalConsole(logMessage);
}

// Функция для логирования действий администратора
function addAdminActionLog(adminId, action) {
  const logEntry = {
    timestamp: new Date(),
    adminId: adminId,
    action: action,
    type: 'ADMIN_ACTION'
  };
  
  systemCache.actionLog.push(logEntry);
  
  // Ограничиваем размер лога действий
  if (systemCache.actionLog.length > 100) {
    systemCache.actionLog.shift();
  }
  
  addToSystemLog(`Админ ${adminId}: ${action}`, 'ADMIN_ACTION');
}
function getMainKeyboard() {
  return Markup.keyboard([
    ['🩹 Уход за тату', '⚠️ Возможные проблемы'],
    ['🚫 Что нельзя делать', '⏱ Мои напоминания'],
    ['📊 Статус заживления', '❓ Задать вопрос'],
    ['📅 Запись', '🔬 Лазерное удаление']
  ]).resize();
}
// Простая функция для безопасного логирования админ-действий
function logAdminAction(action, userId) {
  const timestamp = new Date().toLocaleString('ru-RU');
  console.log(`👑 [${timestamp}] Админ ${userId}: ${action}`);
}

function addBackButton() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Назад к списку запретов', 'back_to_taboo')]
  ]);
}

function addBackToProblemsButton() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Назад к списку проблем', 'back_to_problems')]
  ]);
}

function addBackToQuestionsButton() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Назад к вопросам', 'back_to_questions')]
  ]);
}

// Переменные БД
let db;
let UserModel;

// Подключение к БД
async function connectDB() {
  try {
    console.log('Подключение к MongoDB Atlas...');
    
    // Если уже подключены, возвращаем существующее соединение
    if (mongoose.connection.readyState === 1) {
      console.log('✅ Уже подключено к MongoDB');
      return mongoose.connection;
    }
    
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    
    console.log('✅ MongoDB Atlas подключена через Mongoose');
    
    // Создаем модель пользователя с проверкой на существование
    const userSchema = new mongoose.Schema({
      telegramId: { type: Number, required: true, unique: true },
      username: String,
      firstName: String,
      lastName: String,
      tattooDate: Date,
      stage: String,
      reminders: Array,
      reminderSettings: Object,
      settings: Object,
      createdAt: Date,
      lastActive: Date,
      activity: Object,
      // Добавляем поле для вопросов пользователя
      questions: [{
        question: String,
        date: Date,
        status: { type: String, default: 'pending' },
        answer: String,
        answeredAt: Date
      }],
      isAdmin: { type: Boolean, default: false },
      adminPermissions: {
        fullAccess: { type: Boolean, default: false },
        canManageUsers: { type: Boolean, default: false },
        canManageQuestions: { type: Boolean, default: false },
        canManageSettings: { type: Boolean, default: false },
        canSendBroadcasts: { type: Boolean, default: false },
        canViewAnalytics: { type: Boolean, default: false }
      }
    });
    
    // Проверяем, существует ли уже модель User
    UserModel = mongoose.models.User || mongoose.model('User', userSchema);
    
    // Создаем объект для доступа к БД
    db = {
      User: UserModel,
      mongoose: mongoose
    };

    // Модель для записей
    const appointmentSchema = new mongoose.Schema({
        userId: { type: Number, required: true },
          userName: String,
          userContact: String,
          type: { 
            type: String, 
            enum: ['consultation', 'tattoo', 'laser'],   // ← добавлено 'laser'
            required: true 
          },
          date: Date,
          comment: String,
          status: { type: String, default: 'pending', enum: ['pending', 'confirmed', 'cancelled'] },
          createdAt: { type: Date, default: Date.now }
    });
    const AppointmentModel = mongoose.models.Appointment || mongoose.model('Appointment', appointmentSchema);

    // Добавляем в db
    db.Appointment = AppointmentModel;
    
    return db;
  } catch (error) {
    console.error('❌ Ошибка подключения к MongoDB:', error.message);
    
    if (error.message.includes('SSL')) {
      console.error('\n🔐 SSL ошибка. Попробуйте:');
      console.error('1. Обновить Node.js до последней версии');
      console.error('2. Добавить &tls=true в строку подключения');
      console.error('3. Временно использовать &ssl=false для теста');
    }
    
    // Не завершаем процесс при ошибке подключения
    // Бот может работать в ограниченном режиме
    return null;
  }
}

// Middleware для работы с пользователями (исправленный под Mongoose)
bot.use(async (ctx, next) => {
  console.log(`📨 Update type: ${ctx.updateType}, User: ${ctx.from?.id}, Text: ${ctx.message?.text}`);
  
  // Если БД не подключена, пропускаем middleware
  if (!db || !db.User) {
    console.log('⚠️ База данных не подключена, пропускаем middleware');
    return next();
  }
  
  if (ctx.from) {
    try {
      // Ищем пользователя
      let user = await db.User.findOne({ telegramId: ctx.from.id });
      
      // Если нет - создаем нового пользователя
      if (!user) {
        user = new db.User({
          telegramId: ctx.from.id,
          username: ctx.from.username || null,
          firstName: ctx.from.first_name || 'Аноним',
          lastName: ctx.from.last_name || '',
          tattooDate: null,
          stage: 'start',
          reminders: [],
          reminderSettings: {
            enabled: false,
            frequency: null,
            nextReminder: null,
            lastSent: null,
            updatedAt: null
          },
          settings: {
            notifications: true,
            language: 'ru'
          },
          createdAt: new Date(),
          lastActive: new Date(),
          activity: {},
          questions: []
        });
        
        await user.save();
        console.log(`👤 Новый пользователь: ${ctx.from.username || ctx.from.id}`);
        
      } else {
        // Для существующих пользователей - добавляем недостающие поля
        if (!user.reminderSettings) {
          user.reminderSettings = {
            enabled: false,
            frequency: null,
            nextReminder: null,
            lastSent: null,
            updatedAt: null
          };
        }
        
        if (!user.activity) {
          user.activity = {};
        }
        
        if (!user.questions) {
          user.questions = [];
        }
        
        // Сохраняем обновления
        user.lastActive = new Date();
        await user.save();
      }
      
      ctx.user = user;
      ctx.db = db;
      
    } catch (dbError) {
      console.error('Ошибка БД в middleware:', dbError.message);
    }
  }

  return next();

});

// Глобальный обработчик callback_query для отладки
bot.on('callback_query', async (ctx, next) => {
  console.log(`📨 Callback: ${ctx.callbackQuery.data}, User: ${ctx.from.id}, Type: ${ctx.updateType}`);
  await next();
});


// Функция для проверки целостности данных пользователей
async function checkDataIntegrity() {
  try {
    if (!db || !db.User) {
      console.log('❌ База данных не подключена, проверка целостности невозможна');
      return;
    }
    
    const users = await db.User.find({});
    console.log(`📊 Проверка целостности данных для ${users.length} пользователей...`);
    
    let fixedCount = 0;
    for (const user of users) {
      let needsUpdate = false;
      
      // Проверяем поле questions
      if (user.questions === undefined) {
        user.questions = [];
        needsUpdate = true;
        console.log(`🔄 Инициализировал questions для пользователя ${user.telegramId}`);
      } else if (!Array.isArray(user.questions)) {
        user.questions = [];
        needsUpdate = true;
        console.log(`🔄 Исправил тип questions для пользователя ${user.telegramId}`);
      }
      
      // Проверяем другие обязательные поля
      if (!user.reminderSettings) {
        user.reminderSettings = {
          enabled: false,
          frequency: null,
          nextReminder: null,
          lastSent: null,
          updatedAt: null
        };
        needsUpdate = true;
      }
      
      if (!user.activity) {
        user.activity = {};
        needsUpdate = true;
      }
      
      if (needsUpdate) {
        await user.save();
        fixedCount++;
      }
    }
    
    if (fixedCount > 0) {
      console.log(`✅ Исправлено ${fixedCount} пользователей`);
    } else {
      console.log('✅ Все данные в порядке');
    }
    
  } catch (error) {
    console.error('❌ Ошибка при проверке целостности данных:', error);
  }
}

//Загрузка администраторов из БД в кэш
async function loadAdminsFromDB() {
  try {
    if (!db || !db.User) {
      systemCache.accessSettings = { admins: [], maxAdmins: 5, lastUpdated: new Date() };
      return;
    }

    const adminUsers = await db.User.find({ isAdmin: true });
    
    systemCache.accessSettings = {
      admins: adminUsers.map(u => ({
        id: u.telegramId,
        name: u.firstName || `Администратор ${u.telegramId}`,
        username: u.username,
        addedAt: u.createdAt || new Date(),
        permissions: u.adminPermissions || {
          fullAccess: false,
          canManageUsers: false,
          canManageQuestions: false,
          canManageSettings: false,
          canSendBroadcasts: false,
          canViewAnalytics: false
        }
      })),
      maxAdmins: 5,
      lastUpdated: new Date()
    };

    // Убедимся, что главный администратор (1427347068) есть в списке
    const mainAdminId = 1427347068;
    const mainExists = systemCache.accessSettings.admins.some(a => a.id === mainAdminId);
    
    if (!mainExists) {
      // Найдём или создадим пользователя-админа в БД
      let mainUser = await db.User.findOne({ telegramId: mainAdminId });
      if (!mainUser) {
        mainUser = new db.User({
          telegramId: mainAdminId,
          firstName: 'Главный администратор',
          username: ctx?.from?.username || 'admin',
          isAdmin: true,
          adminPermissions: {
            fullAccess: true,
            canManageUsers: true,
            canManageQuestions: true,
            canManageSettings: true,
            canSendBroadcasts: true,
            canViewAnalytics: true
          },
          createdAt: new Date(),
          lastActive: new Date()
        });
        await mainUser.save();
      } else {
        // Обновим существующего пользователя
        mainUser.isAdmin = true;
        mainUser.adminPermissions = {
          fullAccess: true,
          canManageUsers: true,
          canManageQuestions: true,
          canManageSettings: true,
          canSendBroadcasts: true,
          canViewAnalytics: true
        };
        await mainUser.save();
      }

      systemCache.accessSettings.admins.push({
        id: mainAdminId,
        name: mainUser.firstName || 'Главный администратор',
        username: mainUser.username,
        addedAt: mainUser.createdAt,
        permissions: mainUser.adminPermissions
      });
    }

    console.log(`✅ Загружено ${systemCache.accessSettings.admins.length} администраторов из БД`);
  } catch (error) {
    console.error('❌ Ошибка загрузки администраторов:', error);
    // Аварийная инициализация
    systemCache.accessSettings = {
      admins: [{
        id: 1427347068,
        name: 'Главный администратор',
        username: 'admin',
        addedAt: new Date(),
        permissions: {
          fullAccess: true,
          canManageUsers: true,
          canManageQuestions: true,
          canManageSettings: true,
          canSendBroadcasts: true,
          canViewAnalytics: true
        }
      }],
      maxAdmins: 5,
      lastUpdated: new Date()
    };
  }
}

// ========== ЗАПУСК БОТА ==========
(async () => {
  try {
    console.log('🚀 Запуск бота...');
    
    // Подключаемся к БД
    console.log('1. Подключаюсь к MongoDB...');
    db = await connectDB();
    
    if (db) {
      console.log('✅ MongoDB подключена');
      
      // Проверяем целостность данных
      console.log('🔍 Проверяю целостность данных...');
      await checkDataIntegrity();

      // 👇 Загружаем администраторов из БД в кэш
      await loadAdminsFromDB();
    } else {
      console.log('⚠️ База данных не подключена, бот будет работать в ограниченном режиме');
    }

    // Определяем режим запуска
    const USE_WEBHOOK = process.env.WEBHOOK_URL || process.env.FUNCTION_NAME;

    if (USE_WEBHOOK) {
      app.use(bot.webhookCallback('/webhook'));

      const PORT = process.env.PORT || 3000;
         app.listen(PORT, '0.0.0.0', () => {
        console.log(`✅ Бот запущен в режиме вебхука, слушает порт ${PORT}`);
        console.log(`🌍 URL вебхука: ${process.env.WEBHOOK_URL || `http://localhost:${PORT}/webhook`}`);
      });

      if (process.env.FUNCTION_NAME) {
        exports.handler = serverless(app);
      }
    } else {
      // Режим long polling (локально)
      bot.launch(() => {
        console.log('✅ Бот запущен в режиме long polling');
        console.log('🤖 Бот готов к работе!');
        console.log('🎉 Все системы запущены!');

        // Добавляем heartbeat
        setInterval(() => {
          console.log(`💓 Бот активен: ${new Date().toLocaleTimeString('ru-RU')}`);
        }, 5 * 60 * 1000); // Каждые 5 минут
      });
    }

  } catch (error) {
    console.error('❌ Критическая ошибка запуска:', error);
    process.exit(1);
  }
})();


app.use(bot.webhookCallback('/webhook'));
// ========== КОМАНДЫ ==========

// Функция для отображения главной клавиатуры
function getMainKeyboard() {
  return Markup.keyboard([
    ['🩹 Уход за тату', '⚠️ Возможные проблемы'],
    ['🚫 Что нельзя делать', '⏱ Мои напоминания'],
    ['📊 Статус заживления', '❓ Задать вопрос'],
    ['📅 Запись', '🔬 Лазерное удаление']  
  ]).resize();
}

// Команда /start
bot.start(async (ctx) => {
  await ctx.replyWithHTML(
    '👋 <strong>Привет! Я твой помощник по уходу за татуировкой!</strong>\n\n' +
    'Я помогу:\n' +
    '• Следить за процессом заживления\n' +
    '• Напоминать о процедурах\n' +
    '• Отвечать на вопросы\n' +
    '• Предотвращать проблемы\n\n' +
    '📅 <b>Когда ты сделал(а) татуировку?</b>\n' +
    '(например: сегодня, вчера, 15.01.2024)',
    Markup.keyboard([
      ['📅 Сегодня', '📅 Вчера'],
      ['📅 Запись', '🔬 Лазерное удаление'],
      ['🚫 Пропустить']
    ]).resize()
  );
  
  if (ctx.db && ctx.user) {
    await ctx.db.User.updateOne(
      { telegramId: ctx.from.id },
      { $set: { stage: 'awaiting_tattoo_date' } }
    );
  }
});

// ========== КОМАНДА /DEBUG - ИСПРАВЛЕННАЯ ==========
bot.command('debug', async (ctx) => {
  console.log(`🔄 Команда debug от ${ctx.from.id}`);
  
  try {
    let message = `🔧 <b>ИНФОРМАЦИЯ О СИСТЕМЕ</b>\n\n`;
    message += `• <b>Node.js:</b> ${process.version}\n`;
    
    // Получаем версию Telegraf безопасным способом
    try {
      const telegrafPkg = require('telegraf/package.json');
      message += `• <b>Telegraf:</b> ${telegrafPkg.version}\n`;
    } catch (e) {
      message += `• <b>Telegraf:</b> 4.x (версия не доступна)\n`;
    }
    
    // Получаем версию Mongoose безопасным способом
    try {
      const mongoosePkg = require('mongoose/package.json');
      message += `• <b>Mongoose:</b> ${mongoosePkg.version}\n`;
    } catch (e) {
      message += `• <b>Mongoose:</b> ${mongoose.version || '6.x'}\n`;
    }
    
    message += `• <b>Время сервера:</b> ${new Date().toLocaleString('ru-RU')}\n`;
    message += `• <b>Состояние БД:</b> ${mongoose.connection.readyState === 1 ? '✅ Подключена' : '❌ Не подключена'}\n`;
    message += `• <b>Пользователь:</b> ${ctx.from.id} (@${ctx.from.username || 'нет'})\n`;
    message += `• <b>Chat ID:</b> ${ctx.chat.id}\n`;
    
    await ctx.replyWithHTML(message);
    
  } catch (error) {
    console.error('❌ Ошибка в debug:', error);
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

// ========== КОМАНДА /MYQUESTINGS - УЛУЧШЕННАЯ С ЛОГИРОВАНИЕМ ==========
bot.command('myquestions', async (ctx) => {
  console.log(`🔄 Команда myquestions от ${ctx.from.id}`);
  
  // Немедленный ответ
  await ctx.reply('🔄 Получаю ваши вопросы...');
  
  try {
    if (!ctx.db || !ctx.user) {
      console.log('❌ ctx.db или ctx.user не определены');
      return ctx.reply('❌ База данных не инициализирована. Попробуйте позже.');
    }
    
    // Получаем свежие данные пользователя
    console.log(`🔍 Ищу пользователя ${ctx.from.id} в БД...`);
    const user = await ctx.db.User.findOne({ telegramId: ctx.from.id });
    
    if (!user) {
      console.log('❌ Пользователь не найден в БД');
      return ctx.reply('❌ Пользователь не найден. Используйте /start');
    }
    
    console.log(`✅ Пользователь найден, вопросы:`, user.questions);
    
    // Проверяем наличие поля questions
    if (!user.questions) {
      console.log('⚠️ Поле questions не существует, инициализируем...');
      await ctx.db.User.updateOne(
        { telegramId: ctx.from.id },
        { $set: { questions: [] } }
      );
      return ctx.reply('📝 У вас пока нет заданных вопросов. Поле инициализировано.');
    }
    
    if (!Array.isArray(user.questions)) {
      console.log('❌ Поле questions не является массивом:', typeof user.questions);
      return ctx.reply('❌ Ошибка: поле вопросов имеет неверный формат. Свяжитесь с поддержкой.');
    }
    
    if (user.questions.length === 0) {
      console.log('ℹ️ Массив questions пустой');
      return ctx.reply('📝 У вас пока нет заданных вопросов.');
    }
    
    console.log(`✅ Найдено ${user.questions.length} вопросов`);
    
    let message = '📋 <b>ВАШИ ВОПРОСЫ:</b>\n\n';
    
    // Сортируем вопросы по дате (новые сверху)
    const sortedQuestions = [...user.questions].sort((a, b) => {
      return new Date(b.date || 0) - new Date(a.date || 0);
    });
    
    sortedQuestions.forEach((q, index) => {
      const date = q.date ? new Date(q.date).toLocaleString('ru-RU') : 'Дата не указана';
      const status = q.status === 'answered' ? '✅ Отвечен' : 
                    q.status === 'pending' ? '⏳ Ожидает ответа' : 
                    `❓ ${q.status || 'Неизвестно'}`;
      
      message += `<b>❓ Вопрос ${index + 1}:</b>\n`;
      message += `<b>📅 Дата:</b> ${date}\n`;
      message += `<b>📊 Статус:</b> ${status}\n`;
      
      if (q.question) {
        const questionText = q.question.length > 150 ? 
          q.question.substring(0, 150) + '...' : q.question;
        message += `<b>💬 Вопрос:</b> ${questionText}\n`;
      }
      
      if (q.answer) {
        const answerText = q.answer.length > 150 ? 
          q.answer.substring(0, 150) + '...' : q.answer;
        message += `<b>📝 Ответ:</b> ${answerText}\n`;
      }
      
      message += '─'.repeat(30) + '\n\n';
    });
    
    await ctx.replyWithHTML(message);
    console.log(`✅ Ответ отправлен пользователю ${ctx.from.id}`);
    
  } catch (error) {
    console.error('❌ Критическая ошибка в myquestions:', error);
    await ctx.reply(`❌ Произошла ошибка: ${error.message}\n\nПожалуйста, попробуйте позже или свяжитесь с поддержкой.`);
  }
});

// ========== КОМАНДА /DEBUGUSER - ДОБАВЛЯЕМ ЛОГИРОВАНИЕ ==========
bot.command('debuguser', async (ctx) => {
  console.log(`🔄 Команда debuguser от ${ctx.from.id}`);
  
  await ctx.reply('🔄 Получаю информацию...');
  
  try {
    if (!ctx.db || !ctx.user) {
      console.log('❌ ctx.db или ctx.user не определены');
      return ctx.reply('❌ База данных не инициализирована в контексте.');
    }
    
    console.log(`🔍 Ищу пользователя ${ctx.from.id} в БД...`);
    const user = await ctx.db.User.findOne({ telegramId: ctx.from.id });
    
    if (!user) {
      console.log('❌ Пользователь не найден в БД');
      return ctx.reply('❌ Пользователь не найден в базе данных.');
    }
    
    console.log(`✅ Пользователь найден, вопросы:`, user.questions);
    
    let message = '🔍 <b>ОТЛАДОЧНАЯ ИНФОРМАЦИЯ О ПОЛЬЗОВАТЕЛЕ</b>\n\n';
    message += `🆔 <b>Telegram ID:</b> ${ctx.from.id}\n`;
    message += `👤 <b>Имя:</b> ${ctx.from.first_name || 'Нет'}\n`;
    message += `📱 <b>Username:</b> @${ctx.from.username || 'Нет'}\n\n`;
    
    message += `📅 <b>ДАННЫЕ ИЗ БАЗЫ:</b>\n`;
    message += `• ID в БД: ${user._id || 'Нет'}\n`;
    message += `• Создан: ${user.createdAt ? user.createdAt.toLocaleString('ru-RU') : 'Нет'}\n`;
    message += `• Стадия: ${user.stage || 'Не указана'}\n`;
    message += `• Дата тату: ${user.tattooDate ? user.tattooDate.toLocaleDateString('ru-RU') : 'Не указана'}\n`;
    message += `• Последняя активность: ${user.lastActive ? user.lastActive.toLocaleString('ru-RU') : 'Нет'}\n`;
    
    // Информация о вопросах
    message += `\n📋 <b>ВОПРОСЫ:</b>\n`;
    
    if (user.questions === undefined) {
      message += `• <b>Поле questions:</b> ❌ Не определено\n`;
    } else if (!Array.isArray(user.questions)) {
      message += `• <b>Тип questions:</b> ❌ Не массив (${typeof user.questions})\n`;
    } else {
      message += `• <b>Количество вопросов:</b> ${user.questions.length}\n`;
      
      // Статистика по статусам
      const statusCount = {};
      user.questions.forEach(q => {
        const status = q.status || 'unknown';
        statusCount[status] = (statusCount[status] || 0) + 1;
      });
      
      message += `• <b>По статусам:</b> `;
      const statusParts = [];
      for (const [status, count] of Object.entries(statusCount)) {
        statusParts.push(`${status}: ${count}`);
      }
      message += statusParts.join(', ') + '\n';
      
      if (user.questions.length > 0) {
        message += `\n📋 <b>ПОСЛЕДНИЕ ВОПРОСЫ:</b>\n`;
        
        // Берем последние 3 вопроса
        const recentQuestions = user.questions.slice(-3);
        recentQuestions.forEach((q, i) => {
          const index = user.questions.length - 3 + i;
          message += `\n<b>Вопрос ${index + 1}:</b>\n`;
          message += `Дата: ${q.date ? q.date.toLocaleString('ru-RU') : 'Нет'}\n`;
          message += `Статус: ${q.status || 'pending'}\n`;
          
          if (q.question) {
            const questionText = q.question.length > 80 ? 
              q.question.substring(0, 80) + '...' : q.question;
            message += `Текст: ${questionText}\n`;
          }
          
          if (q.answer) {
            message += `✅ Есть ответ\n`;
          }
        });
      }
    }
    
    // Информация о подключении к БД
    message += `\n🗄️ <b>СИСТЕМНАЯ ИНФОРМАЦИЯ:</b>\n`;
    message += `• MongoDB состояние: ${mongoose.connection.readyState === 1 ? '✅ Подключена' : '❌ Не подключена'}\n`;
    message += `• Коллекция User: ${ctx.db.User ? '✅ Доступна' : '❌ Не доступна'}\n`;
    message += `• Время сервера: ${new Date().toLocaleString('ru-RU')}\n`;
    
    await ctx.replyWithHTML(message);
    console.log(`✅ Debug информация отправлена пользователю ${ctx.from.id}`);
    
  } catch (error) {
    console.error('❌ Ошибка в debuguser:', error);
    await ctx.reply(`❌ Ошибка: ${error.message}\n\nПопробуйте позже.`);
  }
});

// ========== КОМАНДА /STATS - УЛУЧШЕННАЯ ==========
bot.command('stats', async (ctx) => {
  console.log(`🔄 Команда stats от ${ctx.from.id}`);
  
  const ADMIN_ID = 1427347068;
  
  if (ctx.from.id !== ADMIN_ID) {
    console.log(`❌ Пользователь ${ctx.from.id} не является админом`);
    return ctx.reply('❌ У вас нет прав администратора');
  }
  
  await ctx.reply('🔄 Получаю статистику...');
  
  try {
    if (!ctx.db || !ctx.db.User) {
      console.log('❌ ctx.db.User не доступен');
      return ctx.reply('❌ Модель User не доступна в базе данных');
    }
    
    console.log('📊 Собираю статистику...');
    
    const totalUsers = await ctx.db.User.countDocuments({});
    
    // Сегодняшние пользователи
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayUsers = await ctx.db.User.countDocuments({
      createdAt: { $gte: today }
    });
    
    // Пользователи с датой тату
    const usersWithTattoo = await ctx.db.User.countDocuments({
      tattooDate: { $ne: null }
    });
    
    // Активные пользователи (за последние 7 дней)
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const activeUsers = await ctx.db.User.countDocuments({
      lastActive: { $gte: weekAgo }
    });
    
    // Получаем всех пользователей для подсчета вопросов
    const allUsers = await ctx.db.User.find({});
    
    let totalQuestions = 0;
    let pendingQuestions = 0;
    let answeredQuestions = 0;
    let usersWithQuestions = 0;
    
    allUsers.forEach(user => {
      if (user.questions && Array.isArray(user.questions)) {
        const userQuestionsCount = user.questions.length;
        if (userQuestionsCount > 0) {
          usersWithQuestions++;
          totalQuestions += userQuestionsCount;
          
          user.questions.forEach(q => {
            if (q.status === 'pending') pendingQuestions++;
            if (q.status === 'answered') answeredQuestions++;
          });
        }
      }
    });
    
    await ctx.replyWithHTML(
      `📊 <b>СТАТИСТИКА БОТА</b>\n\n` +
      `👥 <b>Всего пользователей:</b> ${totalUsers}\n` +
      `📈 <b>Новых сегодня:</b> ${todayUsers}\n` +
      `🎯 <b>Активных (7 дней):</b> ${activeUsers}\n` +
      `🎨 <b>Указали дату тату:</b> ${usersWithTattoo} (${totalUsers > 0 ? Math.round((usersWithTattoo / totalUsers) * 100) : 0}%)\n\n` +
      `❓ <b>ВОПРОСЫ ПОЛЬЗОВАТЕЛЕЙ:</b>\n` +
      `• Всего вопросов: ${totalQuestions}\n` +
      `• Задали вопросы: ${usersWithQuestions}\n` +
      `• Ожидают ответа: ${pendingQuestions}\n` +
      `• Отвечено: ${answeredQuestions}\n\n` +
      `🔄 <b>ПОСЛЕДНИЙ ЗАПУСК:</b>\n` +
      `• Время: ${new Date().toLocaleString('ru-RU')}\n` +
      `• ID администратора: ${ADMIN_ID}\n` +
      `• Статус БД: ${mongoose.connection.readyState === 1 ? '✅ Онлайн' : '❌ Оффлайн'}`
    );
    
    console.log(`✅ Статистика отправлена администратору ${ctx.from.id}`);
    
  } catch (error) {
    console.error('❌ Ошибка в stats:', error);
    await ctx.reply(`❌ Ошибка получения статистики: ${error.message}`);
  }
});

// ========== КОМАНДА /SETDATE ==========
bot.command('setdate', async (ctx) => {
  await ctx.replyWithHTML(
    '📅 <b>Установите дату татуировки:</b>\n\n' +
    'Отправьте дату в формате:\n' +
    '• "сегодня"\n' +
    '• "вчера"\n' +
    '• "15.01.2024"\n\n' +
    'Или выберите вариант ниже:',
    Markup.keyboard([
      ['📅 Сегодня', '📅 Вчера'],
      ['🚫 Отмена']
    ]).resize()
  );
  
  if (ctx.db && ctx.user) {
    await ctx.db.User.updateOne(
      { telegramId: ctx.from.id },
      { $set: { stage: 'awaiting_tattoo_date' } }
    );
  }
});

// ========== АДМИН ПАНЕЛЬ ==========

// Команда /admin - основная панель администратора
bot.command('admin', async (ctx) => {
   if (!ctx.user || !ctx.user.isAdmin) {
    return ctx.reply('❌ У вас нет прав администратора');
  }
  
  await ctx.replyWithHTML(
    '👑 <b>ПАНЕЛЬ АДМИНИСТРАТОРА</b>\n\n' +
    'Выберите действие:',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('📊 Статистика', 'admin_stats'),
        Markup.button.callback('👥 Пользователи', 'admin_users')
      ],
      [
        Markup.button.callback('❓ Вопросы пользователей', 'admin_questions'),
        Markup.button.callback('🔧 Управление', 'admin_manage')
      ],
      [
        Markup.button.callback('📢 Рассылка', 'admin_broadcast'),
        Markup.button.callback('📈 Аналитика', 'admin_analytics')
      ],

      [
        Markup.button.callback('⚙️ Настройки', 'admin_settings')
      ]
    ]).resize()
  );
});

// Команда /users - просмотр пользователей
bot.command('users', async (ctx) => {
  const ADMIN_ID = 1427347068;
  
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply('❌ У вас нет прав администратора');
  }
  
  await showUsersList(ctx, 1);
});

// Функция для отображения списка пользователей (ИСПРАВЛЕННАЯ)
async function showUsersList(ctx, page = 1, isRefresh = false) {
  try {
    const ADMIN_ID = 1427347068;
    
    // Проверка прав администратора
    if (ctx.from.id !== ADMIN_ID) {
      const errorMsg = '❌ У вас нет прав администратора';
      if (ctx.updateType === 'callback_query') {
        await ctx.answerCbQuery(errorMsg);
        await ctx.editMessageText(errorMsg);
      } else {
        await ctx.reply(errorMsg);
      }
      return false;
    }
    
    // Проверка подключения к БД
    if (!ctx.db || !ctx.db.User) {
      const errorMsg = '❌ База данных не доступна';
      if (ctx.updateType === 'callback_query') {
        await ctx.answerCbQuery(errorMsg);
        await ctx.editMessageText(errorMsg);
      } else {
        await ctx.reply(errorMsg);
      }
      return false;
    }
    
    const limit = 10;
    const skip = (page - 1) * limit;
    
    const users = await ctx.db.User.find({})
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);
    
    const totalUsers = await ctx.db.User.countDocuments({});
    const totalPages = Math.ceil(totalUsers / limit);
    
    let message = `👥 <b>ПОЛЬЗОВАТЕЛИ</b> (страница ${page}/${totalPages})\n\n`;
    
    users.forEach((user, index) => {
      const userNumber = skip + index + 1;
      const hasTattoo = user.tattooDate ? '✅' : '❌';
      const questionsCount = user.questions?.length || 0;
      
      message += `<b>${userNumber}. ${user.firstName || 'Аноним'}</b>\n`;
      message += `ID: ${user.telegramId}\n`;
      message += `Тату: ${hasTattoo} | Вопросов: ${questionsCount}\n`;
      message += `Дата: ${user.createdAt?.toLocaleDateString('ru-RU') || 'н/д'}\n`;
      message += `────────────────────\n`;
    });
    
    message += `\n📊 <b>Всего пользователей:</b> ${totalUsers}`;
    
    // Добавляем время обновления только при refresh
    if (isRefresh) {
      const updateTime = new Date();
      const timeString = updateTime.toLocaleTimeString('ru-RU');
      message += `\n🕒 <b>Обновлено:</b> ${timeString}`;
    }
    
    // Создаем клавиатуру с пагинацией
    const keyboardButtons = [];
    
    // Кнопки навигации
    const navRow = [];
    if (page > 1) {
      navRow.push(Markup.button.callback('⬅️ Назад', `admin_users_page_${page - 1}`));
    }
    
    if (page < totalPages) {
      navRow.push(Markup.button.callback('Вперед ➡️', `admin_users_page_${page + 1}`));
    }
    
    if (navRow.length > 0) {
      keyboardButtons.push(navRow);
    }
    
    // Кнопки действий
    keyboardButtons.push([
      Markup.button.callback('🔄 Обновить', `admin_users_refresh_${page}`),
      Markup.button.callback('📊 Статистика', 'admin_stats')
    ]);
    
    keyboardButtons.push([Markup.button.callback('🔙 Назад', 'admin_back')]);
    
    const keyboard = Markup.inlineKeyboard(keyboardButtons);
    
    if (ctx.updateType === 'callback_query') {
      try {
        await ctx.editMessageText(message, {
          parse_mode: 'HTML',
          ...keyboard
        });
        await ctx.answerCbQuery();
        return true;
      } catch (editError) {
        // Если ошибка "message not modified", просто игнорируем
        if (editError.response && editError.response.description && 
            editError.response.description.includes('message is not modified')) {
          console.log('ℹ️ Сообщение не изменилось, пропускаем ошибку');
          await ctx.answerCbQuery();
          return true;
        }
        throw editError;
      }
    } else {
      await ctx.replyWithHTML(message, keyboard);
      return true;
    }
    
  } catch (error) {
    console.error('Ошибка при отображении пользователей:', error);
    
    const errorMessage = `❌ Ошибка при загрузке пользователей:\n${error.message}`;
    
    if (ctx.updateType === 'callback_query') {
      try {
        await ctx.editMessageText(errorMessage, {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Попробовать снова', 'admin_users')],
            [Markup.button.callback('🔙 Назад', 'admin_back')]
          ])
        });
        await ctx.answerCbQuery('❌ Ошибка');
      } catch (editError) {
        await ctx.answerCbQuery('❌ Ошибка загрузки');
      }
    } else {
      await ctx.reply(errorMessage);
    }
    return false;
  }
}


// Функция для создания резервной копии базы данных
async function createBackup(ctx) {
  try {
    console.log(`💾 Админ ${ctx.from.id} начал создание резервной копии`);
    
    // Получаем всех пользователей из базы данных
    const users = await ctx.db.User.find({}).lean();
    
    // Подготавливаем данные для резервной копии
    const backupData = {
      timestamp: new Date().toISOString(),
      totalUsers: users.length,
      users: users.map(user => ({
        telegramId: user.telegramId,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        tattooDate: user.tattooDate,
        stage: user.stage,
        questions: user.questions || [],
        createdAt: user.createdAt,
        lastActive: user.lastActive
      }))
    };
    
    // Конвертируем в JSON с отступами для читаемости
    const jsonData = JSON.stringify(backupData, null, 2);
    
    // Создаем имя файла с текущей датой и временем
    const now = new Date();
    const fileName = `tattoo-bot-backup-${now.getFullYear()}-${(now.getMonth()+1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}_${now.getHours().toString().padStart(2, '0')}-${now.getMinutes().toString().padStart(2, '0')}.json`;
    
    // Отправляем файл администратору
    await ctx.replyWithDocument({
      source: Buffer.from(jsonData, 'utf8'),
      filename: fileName
    }, {
      caption: `💾 <b>Резервная копия создана</b>\n\n` +
               `📅 <b>Дата:</b> ${now.toLocaleString('ru-RU')}\n` +
               `👥 <b>Пользователей:</b> ${users.length}\n` +
               `📊 <b>Размер файла:</b> ${(Buffer.byteLength(jsonData, 'utf8') / 1024).toFixed(2)} КБ`,
      parse_mode: 'HTML'
    });
    
    console.log(`✅ Резервная копия успешно создана и отправлена администратору ${ctx.from.id}`);
    return true;
    
  } catch (error) {
    console.error('❌ Ошибка при создании резервной копии:', error);
    await ctx.reply(`❌ Произошла ошибка при создании резервной копии:\n<code>${error.message}</code>`, {
      parse_mode: 'HTML'
    });
    return false;
  }
}

// Функция для отображения системных логов
async function showSystemLogs(ctx, page = 1, logType = 'all', isRefresh = false) {
  try {
    const ADMIN_ID = 1427347068;
    if (ctx.from.id !== ADMIN_ID) {
      return;
    }
    
    addAdminActionLog(ctx.from.id, `просмотр логов, страница ${page}, тип: ${logType}`);
    
    const logsPerPage = 10;
    const skip = (page - 1) * logsPerPage;
    
    // Фильтрация логов по типу
    let filteredLogs = [...systemCache.systemLogs];
    if (logType !== 'all') {
      filteredLogs = filteredLogs.filter(log => log.type === logType);
    }
    
    // Сортируем по дате (новые сверху)
    filteredLogs.sort((a, b) => b.timestamp - a.timestamp);
    
    const totalLogs = filteredLogs.length;
    const totalPages = Math.ceil(totalLogs / logsPerPage) || 1;
    
    // Получаем логи для текущей страницы
    const pageLogs = filteredLogs.slice(skip, skip + logsPerPage);
    
    // Собираем статистику по типам логов
    const logStats = {};
    systemCache.systemLogs.forEach(log => {
      logStats[log.type] = (logStats[log.type] || 0) + 1;
    });
    
    // Создаем сообщение
    let message = `📋 <b>СИСТЕМНЫЕ ЛОГИ</b>`;
    
    if (logType !== 'all') {
      message += ` (фильтр: ${logType})`;
    }
    
    message += ` - страница ${page}/${totalPages}\n\n`;
    
    if (isRefresh) {
      const updateTime = new Date();
      const timeString = updateTime.toLocaleTimeString('ru-RU');
      message += `🕒 <b>Обновлено:</b> ${timeString}\n\n`;
    }
    
    if (pageLogs.length === 0) {
      message += '📭 Логов не найдено.\n\n';
    } else {
      pageLogs.forEach((log, index) => {
        const logNumber = skip + index + 1;
        const time = log.timestamp.toLocaleTimeString('ru-RU');
        const date = log.timestamp.toLocaleDateString('ru-RU');
        
        // Иконки для разных типов логов
        const icon = log.type === 'ERROR' ? '❌' :
                    log.type === 'ADMIN_ACTION' ? '👑' :
                    log.type === 'BACKUP' ? '💾' :
                    log.type === 'CACHE' ? '🧹' : 'ℹ️';
        
        message += `<b>${logNumber}. ${icon} ${time}</b>\n`;
        message += `📅 ${date} | Тип: ${log.type}\n`;
        
        // Обрезаем длинные сообщения
        const displayMessage = log.message.length > 80 ? 
          log.message.substring(0, 80) + '...' : log.message;
        message += `📝 ${displayMessage}\n`;
        message += `────────────────────\n`;
      });
    }
    
    // Добавляем статистику
    message += `\n📊 <b>Статистика логов:</b>\n`;
    message += `• Всего записей: ${systemCache.systemLogs.length}\n`;
    
    Object.entries(logStats).forEach(([type, count]) => {
      const icon = type === 'ERROR' ? '❌' :
                  type === 'ADMIN_ACTION' ? '👑' :
                  type === 'BACKUP' ? '💾' :
                  type === 'CACHE' ? '🧹' : 'ℹ️';
      message += `• ${icon} ${type}: ${count}\n`;
    });
    
    message += `\n🕒 <b>Диапазон времени:</b>\n`;
    if (systemCache.systemLogs.length > 0) {
      const firstLog = systemCache.systemLogs[0];
      const lastLog = systemCache.systemLogs[systemCache.systemLogs.length - 1];
      message += `• Первая запись: ${firstLog.timestamp.toLocaleString('ru-RU')}\n`;
      message += `• Последняя запись: ${lastLog.timestamp.toLocaleString('ru-RU')}`;
    } else {
      message += `• Нет записей`;
    }
    
    // Создаем клавиатуру с фильтрами и пагинацией
    const keyboard = [];
    
    // Кнопки фильтров
    const filterRow = [];
    if (logType !== 'all') filterRow.push(Markup.button.callback('📋 Все логи', 'admin_logs_all'));
    if (logType !== 'ERROR') filterRow.push(Markup.button.callback('❌ Ошибки', 'admin_logs_error'));
    if (logType !== 'ADMIN_ACTION') filterRow.push(Markup.button.callback('👑 Действия', 'admin_logs_admin'));
    
    if (filterRow.length > 0) {
      keyboard.push(filterRow);
    }
    
    // Кнопки пагинации
    const navRow = [];
    if (page > 1) {
      navRow.push(Markup.button.callback('⬅️ Назад', `admin_logs_page_${page - 1}_${logType}`));
    }
    
    if (page < totalPages) {
      navRow.push(Markup.button.callback('Вперед ➡️', `admin_logs_page_${page + 1}_${logType}`));
    }
    
    if (navRow.length > 0) {
      keyboard.push(navRow);
    }
    
    // Кнопки действий
    keyboard.push([
      Markup.button.callback('🔄 Обновить', `admin_logs_refresh_${page}_${logType}`),
      Markup.button.callback('🧹 Очистить логи', 'admin_logs_clear_confirm')
    ]);
    
    keyboard.push([
      Markup.button.callback('📊 Статистика', 'admin_stats'),
      Markup.button.callback('🔙 Назад в управление', 'admin_manage')
    ]);
    
    if (ctx.updateType === 'callback_query') {
      await ctx.editMessageText(message, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(keyboard)
      });
    } else {
      await ctx.replyWithHTML(message, Markup.inlineKeyboard(keyboard));
    }
    
    return true;
    
  } catch (error) {
    console.error('Ошибка при отображении логов:', error);
    addToSystemLog(`Ошибка при отображении логов: ${error.message}`, 'ERROR');
    
    await ctx.editMessageText(
      '❌ <b>Ошибка при загрузке логов</b>\n\n' +
      `Не удалось загрузить логи: ${error.message}`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Повторить', 'admin_logs')],
          [Markup.button.callback('🔙 Назад', 'admin_manage')]
        ])
      }
    );
    return false;
  }
}

// Функция для отображения производительности системы
async function showPerformance(ctx, isRefresh = false) {
  try {
    const ADMIN_ID = 1427347068;
    if (ctx.from.id !== ADMIN_ID) {
      return;
    }
    
    addToSystemLog(`Админ ${ctx.from.id} запросил информацию о производительности`, 'ADMIN_ACTION');
    
    // Получаем статистику использования памяти
    const memoryUsage = process.memoryUsage();
    
    // Конвертируем байты в мегабайты
    const formatMemory = (bytes) => {
      return (bytes / 1024 / 1024).toFixed(2) + ' MB';
    };
    
    // Форматируем время работы
    const formatUptime = (seconds) => {
      const days = Math.floor(seconds / (24 * 3600));
      const hours = Math.floor((seconds % (24 * 3600)) / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = Math.floor(seconds % 60);
      
      const parts = [];
      if (days > 0) parts.push(`${days}д`);
      if (hours > 0) parts.push(`${hours}ч`);
      if (minutes > 0) parts.push(`${minutes}м`);
      if (secs > 0 || parts.length === 0) parts.push(`${secs}с`);
      
      return parts.join(' ');
    };
    
    // Статистика базы данных
    const dbStatus = mongoose.connection.readyState === 1 ? '✅ Подключена' : '❌ Отключена';
    const dbCollections = mongoose.connection.collections ? 
      Object.keys(mongoose.connection.collections).length : 0;
    
    // Статистика кэша
    const cacheStatus = systemCache.lastUpdated ? 
      `✅ Активен (${systemCache.userList ? 'с данными' : 'пустой'})` : '❌ Не активен';
    
    // Получаем базовую статистику пользователей
    const totalUsers = await ctx.db.User.countDocuments({}).catch(() => 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const newToday = await ctx.db.User.countDocuments({ 
      createdAt: { $gte: today } 
    }).catch(() => 0);
    
    // Готовим сообщение
    let message = `⚡ <b>ПРОИЗВОДИТЕЛЬНОСТЬ СИСТЕМЫ</b>\n\n`;
    
    if (isRefresh) {
      const updateTime = new Date();
      const timeString = updateTime.toLocaleTimeString('ru-RU');
      message += `🕒 <b>Обновлено:</b> ${timeString}\n\n`;
    }
    
    message += `📊 <b>Использование памяти:</b>\n`;
    message += `• Всего выделено: ${formatMemory(memoryUsage.heapTotal)}\n`;
    message += `• Использовано: ${formatMemory(memoryUsage.heapUsed)}\n`;
    message += `• RSS (резидентная): ${formatMemory(memoryUsage.rss)}\n`;
    message += `• Внешняя память: ${formatMemory(memoryUsage.external)}\n\n`;
    
    message += `⏱️ <b>Время работы:</b>\n`;
    message += `• Бот: ${formatUptime(process.uptime())}\n`;
    message += `• Серверное время: ${new Date().toLocaleString('ru-RU')}\n\n`;
    
    message += `🗄️ <b>База данных:</b>\n`;
    message += `• Статус: ${dbStatus}\n`;
    message += `• Коллекций: ${dbCollections}\n`;
    message += `• Всего пользователей: ${totalUsers}\n`;
    message += `• Новых сегодня: ${newToday}\n\n`;
    
    message += `💾 <b>Системный кэш:</b>\n`;
    message += `• Статус: ${cacheStatus}\n`;
    message += `• Пользователей в кэше: ${systemCache.userList ? systemCache.userList.length : 0}\n`;
    message += `• Записей логов: ${systemCache.systemLogs.length + systemCache.actionLog.length}\n\n`;
    
    message += `🔧 <b>Информация о системе:</b>\n`;
    message += `• Node.js: ${process.version}\n`;
    message += `• Платформа: ${process.platform} ${process.arch}\n`;
    message += `• PID процесса: ${process.pid}\n`;
    message += `• Запущен из: ${process.cwd()}\n`;
    message += `• Режим запуска: ${process.env.npm_lifecycle_event || 'node'}\n`;
    message += `• Аргументы: ${process.argv.slice(2).join(' ') || 'нет'}`;
    
    // Клавиатура
    const keyboard = [
      [
        Markup.button.callback('🔄 Обновить', 'admin_performance_refresh'),
        Markup.button.callback('📋 Логи', 'admin_logs')
      ],
      [
        Markup.button.callback('💾 Резервная копия', 'admin_backup'),
        Markup.button.callback('🧹 Очистить кэш', 'admin_clear_cache')
      ],
      [
        Markup.button.callback('⚙️ Настройки БД', 'admin_db_settings'),
        Markup.button.callback('🔙 Назад в управление', 'admin_manage')
      ]
    ];
    
    if (ctx.updateType === 'callback_query') {
      await ctx.editMessageText(message, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(keyboard)
      });
    } else {
      await ctx.replyWithHTML(message, Markup.inlineKeyboard(keyboard));
    }
    
    return true;
    
  } catch (error) {
    console.error('Ошибка при отображении производительности:', error);
    addToSystemLog(`Ошибка при отображении производительности: ${error.message}`, 'ERROR');
    
    await ctx.editMessageText(
      '❌ <b>Ошибка при загрузке статистики</b>\n\n' +
      `Не удалось получить данные о производительности: ${error.message}`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Повторить', 'admin_performance')],
          [Markup.button.callback('🔙 Назад', 'admin_manage')]
        ])
      }
    );
    return false;
  }
}

async function showChartsMenu(ctx, isRefresh = false) {
  try {
    const ADMIN_ID = 1427347068;
    if (ctx.from.id !== ADMIN_ID) return;

    // Основная статистика для заголовка
    const totalUsers = await ctx.db.User.countDocuments({});
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const newToday = await ctx.db.User.countDocuments({ 
      createdAt: { $gte: today } 
    });

    let message = '📊 <b>ГРАФИКИ АНАЛИТИКИ</b>\n\n';
    
    if (isRefresh) {
      message += `🕒 <b>Обновлено:</b> ${new Date().toLocaleTimeString('ru-RU')}\n\n`;
    }

    message += `📈 <b>Ключевые метрики:</b>\n`;
    message += `• Всего пользователей: ${totalUsers}\n`;
    message += `• Новых сегодня: ${newToday}\n\n`;

    message += `📋 <b>Выберите тип графика:</b>`;

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('👥 Рост пользователей', 'chart_users_growth'),
        Markup.button.callback('📅 Активность по дням', 'chart_daily_activity')
      ],
      [
        Markup.button.callback('❓ Вопросы по дням', 'chart_questions'),
        Markup.button.callback('🎨 Тату по дням', 'chart_tattoo_dates')
      ],
      [
        Markup.button.callback('📱 Активность по часам', 'chart_hourly_activity'),
        Markup.button.callback('📊 Сводная аналитика', 'chart_summary')
      ],
      [
        Markup.button.callback('🔄 Обновить', 'admin_charts_refresh'),
        Markup.button.callback('🔙 Назад к аналитике', 'admin_analytics')
      ]
    ]);

    if (ctx.updateType === 'callback_query') {
      try {
        await ctx.editMessageText(message, {
          parse_mode: 'HTML',
          ...keyboard
        });
        await ctx.answerCbQuery();
        return true;
      } catch (editError) {
        // Если ошибка "message not modified", просто игнорируем
        if (editError.response && editError.response.description && 
            editError.response.description.includes('message is not modified')) {
          console.log('ℹ️ Сообщение не изменилось, пропускаем ошибку');
          await ctx.answerCbQuery();
          return true;
        }
        throw editError;
      }
    } else {
      await ctx.replyWithHTML(message, keyboard);
      return true;
    }

  } catch (error) {
    console.error('Ошибка при отображении меню графиков:', error);
    addToSystemLog(`Ошибка при отображении меню графиков: ${error.message}`, 'ERROR');
    
    const errorMessage = `❌ <b>Ошибка при загрузке графиков</b>\n\n` +
      `Не удалось загрузить данные: ${error.message}`;
    
    if (ctx.updateType === 'callback_query') {
      try {
        await ctx.editMessageText(errorMessage, {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Повторить', 'admin_charts')],
            [Markup.button.callback('🔙 Назад', 'admin_analytics')]
          ])
        });
        await ctx.answerCbQuery('❌ Ошибка');
      } catch (editError) {
        await ctx.answerCbQuery('❌ Ошибка загрузки');
      }
    } else {
      await ctx.reply(errorMessage);
    }
    return false;
  }
}


// Функция для отображения настроек и статуса базы данных
async function showDBSettings(ctx, isRefresh = false) {
  try {
    const ADMIN_ID = 1427347068;
    if (ctx.from.id !== ADMIN_ID) {
      return;
    }

    console.log(`🔍 Отладка: Функция showDBSettings вызвана, isRefresh=${isRefresh}`);
    
    // Проверяем подключение к mongoose
    if (!mongoose || !mongoose.connection) {
      console.error('❌ Mongoose не инициализирован');
      await ctx.editMessageText(
        '❌ <b>ОШИБКА: Mongoose не инициализирован</b>\n\n' +
        'База данных не подключена или возникла ошибка при инициализации.',
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Повторить', 'admin_db_settings')],
            [Markup.button.callback('🔙 Назад', 'admin_manage')]
          ])
        }
      );
      return false;
    }

    addToSystemLog(`Админ ${ctx.from.id} запросил настройки базы данных`, 'ADMIN_ACTION');

    const db = mongoose.connection;
    console.log(`🔍 Отладка: Состояние БД: ${db.readyState}, Хост: ${db.host}, Имя БД: ${db.name}`);

    // Упрощенный вариант без сложной статистики
    const dbStatus = db.readyState === 1 ? '✅ Подключена' : '❌ Отключена';
    
    // Безопасное получение URI
    let safeUri = 'не указана';
    try {
      const mongoUri = process.env.MONGODB_URI || 'не указана';
      safeUri = mongoUri.replace(/mongodb\+srv:\/\/([^:]+):([^@]+)@/, 'mongodb+srv://$1:****@');
    } catch (e) {
      safeUri = 'ошибка при обработке URI';
    }

    // Создаем сообщение (упрощенное)
    let message = `🗄️ <b>НАСТРОЙКИ БАЗЫ ДАННЫХ</b>\n\n`;

    if (isRefresh) {
      message += `🕒 <b>Обновлено:</b> ${new Date().toLocaleTimeString('ru-RU')}\n\n`;
    }

    message += `🔌 <b>Основная информация:</b>\n`;
    message += `• Статус: ${dbStatus}\n`;
    message += `• Состояние (readyState): ${db.readyState}\n`;
    message += `• Имя базы: ${db.name || 'неизвестно'}\n`;
    message += `• Хост: ${db.host || 'не доступен'}\n`;
    message += `• Порт: ${db.port || 'не доступен'}\n\n`;

    message += `🔐 <b>Подключение:</b>\n`;
    message += `• URI (скрытый): <code>${safeUri.substring(0, 60)}${safeUri.length > 60 ? '...' : ''}</code>\n\n`;

    message += `📊 <b>Статистика:</b>\n`;
    
    // Пытаемся получить количество пользователей
    let userCount = 'не доступно';
    try {
      if (ctx.db && ctx.db.User) {
        userCount = await ctx.db.User.countDocuments({});
      }
    } catch (e) {
      userCount = 'ошибка при запросе';
    }
    
    message += `• Пользователей в базе: ${userCount}\n`;
    message += `• Коллекций: ${db.collections ? Object.keys(db.collections).length : 'неизвестно'}\n\n`;

    message += `⚠️ <b>Рекомендации:</b>\n`;
    message += `• Регулярно создавайте резервные копии\n`;
    message += `• Не раскрывайте полный URI\n`;
    message += `• Мониторьте подключение`;

    console.log(`🔍 Отладка: Сообщение сформировано, длина: ${message.length} символов`);

    // Упрощенная клавиатура
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Обновить', 'admin_db_settings_refresh')],
      [Markup.button.callback('💾 Резервная копия', 'admin_backup')],
      [Markup.button.callback('🔙 Назад в управление', 'admin_manage')]
    ]);

    if (ctx.updateType === 'callback_query') {
      try {
        await ctx.editMessageText(message, {
          parse_mode: 'HTML',
          ...keyboard
        });
        console.log(`✅ Сообщение успешно отредактировано для админа ${ctx.from.id}`);
      } catch (editError) {
        console.error('❌ Ошибка при редактировании сообщения:', editError);
        // Пробуем отправить новое сообщение
        await ctx.replyWithHTML(message, keyboard);
      }
    } else {
      await ctx.replyWithHTML(message, keyboard);
    }

    return true;

  } catch (error) {
    console.error('❌ Критическая ошибка в showDBSettings:', error);
    
    // Простое сообщение об ошибке
    await ctx.editMessageText(
      '❌ <b>Ошибка при загрузке настроек БД</b>\n\n' +
      `Причина: ${error.message}\n\n` +
      'Попробуйте еще раз или проверьте подключение к базе данных.',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Повторить', 'admin_db_settings')],
          [Markup.button.callback('🔙 Назад', 'admin_manage')]
        ])
      }
    );
    return false;
  }
}

// ========== ФУНКЦИЯ ДЛЯ НАСТРОЙКИ УВЕДОМЛЕНИЙ ==========

async function showNotificationSettings(ctx, isRefresh = false) {
  try {
    const ADMIN_ID = 1427347068;
    if (ctx.from.id !== ADMIN_ID) return;

    console.log(`🔔 Админ ${ctx.from.id} запросил настройки уведомлений`);
    
    // Проверяем, есть ли настройки в systemCache
    if (!systemCache.adminNotificationSettings) {
      systemCache.adminNotificationSettings = {
        enabled: true,
        types: {
          newUsers: true,
          newQuestions: true,
          errors: true,
          systemAlerts: true,
          broadcastResults: true
        },
        lastUpdated: new Date()
      };
    }

    let message = '🔔 <b>НАСТРОЙКИ УВЕДОМЛЕНИЙ</b>\n\n';
    
    if (isRefresh) {
      const updateTime = new Date();
      const timeString = updateTime.toLocaleTimeString('ru-RU');
      message += `🕒 <b>Обновлено:</b> ${timeString}\n\n`;
    }

    message += `📊 <b>Текущий статус:</b> ${systemCache.adminNotificationSettings.enabled ? '✅ Включены' : '❌ Выключены'}\n\n`;
    
    message += `📋 <b>Типы уведомлений:</b>\n`;
    message += `• 👥 Новые пользователи: ${systemCache.adminNotificationSettings.types.newUsers ? '✅' : '❌'}\n`;
    message += `• ❓ Новые вопросы: ${systemCache.adminNotificationSettings.types.newQuestions ? '✅' : '❌'}\n`;
    message += `• 🚨 Ошибки системы: ${systemCache.adminNotificationSettings.types.errors ? '✅' : '❌'}\n`;
    message += `• ⚡ Системные алерты: ${systemCache.adminNotificationSettings.types.systemAlerts ? '✅' : '❌'}\n`;
    message += `• 📢 Результаты рассылок: ${systemCache.adminNotificationSettings.types.broadcastResults ? '✅' : '❌'}\n\n`;
    
    message += `🕒 <b>Последнее обновление:</b> ${systemCache.adminNotificationSettings.lastUpdated ? systemCache.adminNotificationSettings.lastUpdated.toLocaleString('ru-RU') : 'никогда'}\n\n`;
    
    message += `💡 <b>Рекомендации:</b>\n`;
    message += `• Всегда включайте уведомления об ошибках\n`;
    message += `• Уведомления о новых пользователях помогут отслеживать рост\n`;
    message += `• Системные алерты важны для стабильной работы`;

    // Создаем клавиатуру
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(
          systemCache.adminNotificationSettings.enabled ? '❌ Выключить все' : '✅ Включить все', 
          'admin_notifications_toggle'
        )
      ],
      [
        Markup.button.callback('👥 Новые пользователи', 'admin_notif_toggle_newUsers'),
        Markup.button.callback('❓ Новые вопросы', 'admin_notif_toggle_newQuestions')
      ],
      [
        Markup.button.callback('🚨 Ошибки системы', 'admin_notif_toggle_errors'),
        Markup.button.callback('⚡ Системные алерты', 'admin_notif_toggle_systemAlerts')
      ],
      [
        Markup.button.callback('📢 Результаты рассылок', 'admin_notif_toggle_broadcastResults')
      ],
      [
        Markup.button.callback('🔄 Обновить', 'admin_notifications_refresh'),
        Markup.button.callback('📋 Сохранить в файл', 'admin_notifications_export')
      ],
      [
        Markup.button.callback('🔐 Управление доступом', 'admin_settings_access'),
        Markup.button.callback('🔔 Уведомления', 'admin_settings_notifications')
      ],
      [
        Markup.button.callback('🔙 Назад в настройки', 'admin_settings')
      ]
    ]);

    if (ctx.updateType === 'callback_query') {
      try {
        await ctx.editMessageText(message, {
          parse_mode: 'HTML',
          ...keyboard
        });
        await ctx.answerCbQuery();
        return true;
      } catch (editError) {
        // Если ошибка "message not modified", просто игнорируем
        if (editError.response && editError.response.description && 
            editError.response.description.includes('message is not modified')) {
          console.log('ℹ️ Сообщение не изменилось, пропускаем ошибку');
          await ctx.answerCbQuery();
          return true;
        }
        throw editError;
      }
    } else {
      await ctx.replyWithHTML(message, keyboard);
      return true;
    }

  } catch (error) {
    console.error('Ошибка при отображении настроек уведомлений:', error);
    addToSystemLog(`Ошибка при отображении настроек уведомлений: ${error.message}`, 'ERROR');
    
    await ctx.editMessageText(
      '❌ <b>Ошибка при загрузке настроек уведомлений</b>\n\n' +
      `Не удалось загрузить настройки: ${error.message}`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Повторить', 'admin_settings_notifications')],
          [Markup.button.callback('🔙 Назад', 'admin_settings')]
        ])
      }
    );
    return false;
  }
}

// ========== ФУНКЦИЯ ДЛЯ НАСТРОЙКИ ЯЗЫКА ==========

async function showLanguageSettings(ctx, isRefresh = false) {
  try {
    const ADMIN_ID = 1427347068;
    if (ctx.from.id !== ADMIN_ID) return;

    console.log(`🌐 Админ ${ctx.from.id} открыл настройки языка`);
    
    // Проверяем, есть ли настройки языка в systemCache
    if (!systemCache.adminLanguageSettings) {
      systemCache.adminLanguageSettings = {};
    }
    
    // Получаем текущий язык администратора
    const currentLanguage = systemCache.adminLanguageSettings[ctx.from.id] || 'ru';
    
    const languageNames = {
      'ru': '🇷🇺 Русский',
      'kz': '🇰🇿 Қазақша (Казахский)',
      'en': '🇬🇧 English (Английский)'
    };
    
    const languageDescriptions = {
      'ru': 'Язык интерфейса администратора',
      'kz': 'Әкімші интерфейсінің тілі',
      'en': 'Administrator interface language'
    };

    let message = '🌐 <b>НАСТРОЙКИ ЯЗЫКА</b>\n\n';
    
    if (isRefresh) {
      const updateTime = new Date();
      const timeString = updateTime.toLocaleTimeString('ru-RU');
      message += `🕒 <b>Обновлено:</b> ${timeString}\n\n`;
    }

    message += `📊 <b>Текущий язык:</b> ${languageNames[currentLanguage] || 'Русский'}\n`;
    message += `📝 <b>Описание:</b> ${languageDescriptions[currentLanguage] || 'Язык интерфейса администратора'}\n\n`;
    
    message += `💡 <b>Доступные языки:</b>\n`;
    message += `• 🇷🇺 <b>Русский</b> - основной язык бота\n`;
    message += `• 🇰🇿 <b>Қазақша</b> - казахский язык\n`;
    message += `• 🇬🇧 <b>English</b> - английский язык\n\n`;
    
    message += `⚠️ <b>Примечание:</b>\n`;
    message += `• Смена языка влияет только на интерфейс администратора\n`;
    message += `• Язык пользователей настраивается отдельно\n`;
    message += `• Для полной локализации требуется перевод всех текстов`;

    // Создаем клавиатуру с выбором языка
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(
          currentLanguage === 'ru' ? '✅ 🇷🇺 Русский' : '🇷🇺 Русский', 
          'admin_language_ru'
        )
      ],
      [
        Markup.button.callback(
          currentLanguage === 'kz' ? '✅ 🇰🇿 Қазақша' : '🇰🇿 Қазақша', 
          'admin_language_kz'
        )
      ],
      [
        Markup.button.callback(
          currentLanguage === 'en' ? '✅ 🇬🇧 English' : '🇬🇧 English', 
          'admin_language_en'
        )
      ],
      [
        Markup.button.callback('🔄 Обновить', 'admin_language_refresh'),
        Markup.button.callback('📊 Применить ко всем', 'admin_language_apply_all')
      ],
      [
        Markup.button.callback('🔙 Назад в настройки', 'admin_settings')
      ]
    ]);

    if (ctx.updateType === 'callback_query') {
      try {
        await ctx.editMessageText(message, {
          parse_mode: 'HTML',
          ...keyboard
        });
        await ctx.answerCbQuery();
        return true;
      } catch (editError) {
        // Если ошибка "message not modified", просто игнорируем
        if (editError.response && editError.response.description && 
            editError.response.description.includes('message is not modified')) {
          console.log('ℹ️ Сообщение не изменилось, пропускаем ошибку');
          await ctx.answerCbQuery();
          return true;
        }
        throw editError;
      }
    } else {
      await ctx.replyWithHTML(message, keyboard);
      return true;
    }

  } catch (error) {
    console.error('Ошибка при отображении настроек языка:', error);
    addToSystemLog(`Ошибка при отображении настроек языка: ${error.message}`, 'ERROR');
    
    await ctx.editMessageText(
      '❌ <b>Ошибка при загрузке настроек языка</b>\n\n' +
      `Не удалось загрузить настройки: ${error.message}`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Повторить', 'admin_settings_language')],
          [Markup.button.callback('🔙 Назад', 'admin_settings')]
        ])
      }
    );
    return false;
  }
}

// ========== ФУНКЦИЯ ДЛЯ НАСТРОЙКИ РАБОЧЕГО ВРЕМЕНИ ==========

async function showWorktimeSettings(ctx, isRefresh = false) {
  try {
    const ADMIN_ID = 1427347068;
    if (ctx.from.id !== ADMIN_ID) return;

    console.log(`⏱️ Админ ${ctx.from.id} открыл настройки рабочего времени`);
    
    // Проверяем, есть ли настройки рабочего времени в systemCache
    if (!systemCache.worktimeSettings) {
      systemCache.worktimeSettings = {
        enabled: true,
        workDays: [1, 2, 3, 4, 5], // Пн-Пт (0 - Вс, 1 - Пн, ..., 6 - Сб)
        startHour: 9,
        startMinute: 0,
        endHour: 18,
        endMinute: 0,
        timezone: 'Asia/Almaty', // GMT+6
        notifications: {
          autoReply: true,
          offlineMessage: true,
          weekendMessage: true
        },
        lastUpdated: new Date()
      };
    }

    const daysMap = {
      0: 'Воскресенье',
      1: 'Понедельник',
      2: 'Вторник', 
      3: 'Среда',
      4: 'Четверг',
      5: 'Пятница',
      6: 'Суббота'
    };

    const daysShort = {
      0: 'Вс',
      1: 'Пн',
      2: 'Вт',
      3: 'Ср',
      4: 'Чт',
      5: 'Пт',
      6: 'Сб'
    };

    let message = '⏱️ <b>НАСТРОЙКИ РАБОЧЕГО ВРЕМЕНИ</b>\n\n';
    
    if (isRefresh) {
      const updateTime = new Date();
      const timeString = updateTime.toLocaleTimeString('ru-RU');
      message += `🕒 <b>Обновлено:</b> ${timeString}\n\n`;
    }

    message += `📊 <b>Текущий статус:</b> ${systemCache.worktimeSettings.enabled ? '✅ Включено' : '❌ Выключено'}\n\n`;
    
    // Время работы
    const startTime = `${systemCache.worktimeSettings.startHour.toString().padStart(2, '0')}:${systemCache.worktimeSettings.startMinute.toString().padStart(2, '0')}`;
    const endTime = `${systemCache.worktimeSettings.endHour.toString().padStart(2, '0')}:${systemCache.worktimeSettings.endMinute.toString().padStart(2, '0')}`;
    
    message += `🕐 <b>Рабочее время:</b>\n`;
    message += `• Начало: ${startTime}\n`;
    message += `• Конец: ${endTime}\n`;
    message += `• Часовой пояс: ${systemCache.worktimeSettings.timezone} (GMT+6)\n\n`;
    
    // Рабочие дни
    message += `📅 <b>Рабочие дни:</b>\n`;
    const workDays = systemCache.worktimeSettings.workDays.sort((a, b) => a - b);
    let daysDisplay = '';
    for (let i = 0; i < 7; i++) {
      const isWorkDay = workDays.includes(i);
      daysDisplay += isWorkDay ? `✅` : `❌`;
      daysDisplay += `${daysShort[i]} `;
    }
    message += daysDisplay + '\n\n';
    
    // Уведомления
    message += `🔔 <b>Автоматические уведомления:</b>\n`;
    message += `• Автоответчик: ${systemCache.worktimeSettings.notifications.autoReply ? '✅' : '❌'}\n`;
    message += `• Сообщение о нерабочем времени: ${systemCache.worktimeSettings.notifications.offlineMessage ? '✅' : '❌'}\n`;
    message += `• Сообщение о выходных: ${systemCache.worktimeSettings.notifications.weekendMessage ? '✅' : '❌'}\n\n`;
    
    message += `📋 <b>Текущее время сервера:</b> ${new Date().toLocaleString('ru-RU')}\n`;
    message += `⏰ <b>Сейчас на рабочем месте:</b> ${checkIsWorkTime() ? '✅ Да' : '❌ Нет'}\n\n`;
    
    message += `💡 <b>Рекомендации:</b>\n`;
    message += `• Установите реалистичное рабочее время\n`;
    message += `• Включите автоответчик для нерабочих часов\n`;
    message += `• Регулярно обновляйте расписание`;

    // Создаем клавиатуру
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(
          systemCache.worktimeSettings.enabled ? '❌ Выключить режим' : '✅ Включить режим', 
          'admin_worktime_toggle'
        )
      ],
      [
        Markup.button.callback('🕐 -1 ч', 'admin_worktime_start_hour_dec'),
        Markup.button.callback('Начало', 'admin_worktime_start_time'),
        Markup.button.callback('+1 ч 🕐', 'admin_worktime_start_hour_inc')
      ],
      [
        Markup.button.callback('🕐 -1 ч', 'admin_worktime_end_hour_dec'),
        Markup.button.callback('Конец', 'admin_worktime_end_time'),
        Markup.button.callback('+1 ч 🕐', 'admin_worktime_end_hour_inc')
      ],
      [
        Markup.button.callback('Пн', 'admin_worktime_day_1'),
        Markup.button.callback('Вт', 'admin_worktime_day_2'),
        Markup.button.callback('Ср', 'admin_worktime_day_3'),
        Markup.button.callback('Чт', 'admin_worktime_day_4'),
        Markup.button.callback('Пт', 'admin_worktime_day_5')
      ],
      [
        Markup.button.callback('Сб', 'admin_worktime_day_6'),
        Markup.button.callback('Вс', 'admin_worktime_day_0'),
        Markup.button.callback('📅 Все дни', 'admin_worktime_all_days')
      ],
      [
        Markup.button.callback('🔧 Уведомления', 'admin_worktime_notifications'),
        Markup.button.callback('⏰ Тест', 'admin_worktime_test')
      ],
      [
        Markup.button.callback('🔄 Обновить', 'admin_worktime_refresh'),
        Markup.button.callback('💾 Сохранить', 'admin_worktime_save')
      ],
      [
        Markup.button.callback('🔙 Назад в настройки', 'admin_settings')
      ]
    ]);

    if (ctx.updateType === 'callback_query') {
      try {
        await ctx.editMessageText(message, {
          parse_mode: 'HTML',
          ...keyboard
        });
        await ctx.answerCbQuery();
        return true;
      } catch (editError) {
        // Если ошибка "message not modified", просто игнорируем
        if (editError.response && editError.response.description && 
            editError.response.description.includes('message is not modified')) {
          console.log('ℹ️ Сообщение не изменилось, пропускаем ошибку');
          await ctx.answerCbQuery();
          return true;
        }
        throw editError;
      }
    } else {
      await ctx.replyWithHTML(message, keyboard);
      return true;
    }

  } catch (error) {
    console.error('Ошибка при отображении настроек рабочего времени:', error);
    addToSystemLog(`Ошибка при отображении настроек рабочего времени: ${error.message}`, 'ERROR');
    
    await ctx.editMessageText(
      '❌ <b>Ошибка при загрузке настроек рабочего времени</b>\n\n' +
      `Не удалось загрузить настройки: ${error.message}`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Повторить', 'admin_settings_worktime')],
          [Markup.button.callback('🔙 Назад', 'admin_settings')]
        ])
      }
    );
    return false;
  }
}

// Функция проверки рабочего времени
function checkIsWorkTime() {
  if (!systemCache.worktimeSettings || !systemCache.worktimeSettings.enabled) {
    return true; // Если настройки не включены, считаем что всегда рабочее время
  }
  
  const now = new Date();
  const currentDay = now.getDay(); // 0 - воскресенье, 1 - понедельник, ...
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  
  // Проверяем рабочий день
  if (!systemCache.worktimeSettings.workDays.includes(currentDay)) {
    return false;
  }
  
  // Проверяем время
  const currentTime = currentHour * 60 + currentMinute;
  const startTime = systemCache.worktimeSettings.startHour * 60 + systemCache.worktimeSettings.startMinute;
  const endTime = systemCache.worktimeSettings.endHour * 60 + systemCache.worktimeSettings.endMinute;
  
  return currentTime >= startTime && currentTime <= endTime;
}


// ========== ФУНКЦИЯ ДЛЯ НАСТРОЙКИ ШАБЛОНОВ ОТВЕТОВ ==========

async function showTemplatesSettings(ctx, page = 1, isRefresh = false) {
  try {
    const ADMIN_ID = 1427347068;
    if (ctx.from.id !== ADMIN_ID) return;

    console.log(`📝 Админ ${ctx.from.id} открыл настройки шаблонов ответов`);
    
    // Проверяем, есть ли шаблоны в systemCache
    if (!systemCache.templates) {
      systemCache.templates = {
        templates: [
          {
            id: 1,
            title: "Приветствие нового пользователя",
            text: "👋 Здравствуйте! Рады приветствовать вас в нашем боте по уходу за татуировками. Наш бот поможет вам с рекомендациями по уходу, ответами на вопросы и напоминаниями. Для начала работы укажите дату вашей татуировки через команду /setdate",
            category: "приветствие",
            tags: ["новый", "приветствие", "старт"],
            usageCount: 0,
            createdAt: new Date(),
            updatedAt: new Date()
          },
          {
            id: 2,
            title: "Уход в первые дни",
            text: "🩹 В первые 3 дня после нанесения татуировки:\n\n1. Мойте 2-3 раза в день мягким мылом без отдушек\n2. Наносите тонкий слой Бепантена, Пантенола или Метилурациловая мазь (Последний более дешёвый аналог)\n3. Не сдирайте образовавшиеся корочки\n4. Спите на чистом хлопковом белье\n5. Избегайте трения одеждой",
            category: "уход",
            tags: ["уход", "первые дни", "рекомендации"],
            usageCount: 0,
            createdAt: new Date(),
            updatedAt: new Date()
          },
          {
            id: 3,
            title: "Ответ на вопрос о зуде",
            text: "👐 Сильный зуд после нанесения татуировки - это нормально! Не чешите татуировку, это может повредить кожу и рисунок. \n\nМожно:\n• Похлопывать кожу\n• Прикладывать холодный компресс через ткань\n• Использовать увлажняющий крем с пантенолом\n\nЗуд обычно проходит через 7-10 дней.",
            category: "проблемы",
            tags: ["зуд", "проблемы", "рекомендации"],
            usageCount: 0,
            createdAt: new Date(),
            updatedAt: new Date()
          },
          {
            id: 4,
            title: "Напоминание о приеме у мастера",
            text: "🎨 Не забудьте записаться на контрольный прием к вашему мастеру через 4-6 недель после нанесения татуировки. Это важно для:\n\n• Проверки качества заживления\n• Коррекции при необходимости\n• Консультации по дальнейшему уходу",
            category: "напоминания",
            tags: ["мастер", "прием", "коррекция"],
            usageCount: 0,
            createdAt: new Date(),
            updatedAt: new Date()
          }
        ],
        categories: ["приветствие", "уход", "проблемы", "напоминания", "ответы", "инструкции"],
        lastUpdated: new Date()
      };
    }

    const templates = systemCache.templates.templates;
    const categories = systemCache.templates.categories;
    
    const templatesPerPage = 5;
    const startIndex = (page - 1) * templatesPerPage;
    const endIndex = startIndex + templatesPerPage;
    const paginatedTemplates = templates.slice(startIndex, endIndex);
    const totalPages = Math.ceil(templates.length / templatesPerPage);

    let message = '📝 <b>ШАБЛОНЫ ОТВЕТОВ</b>\n\n';
    
    if (isRefresh) {
      const updateTime = new Date();
      const timeString = updateTime.toLocaleTimeString('ru-RU');
      message += `🕒 <b>Обновлено:</b> ${timeString}\n\n`;
    }

    message += `📊 <b>Статистика:</b>\n`;
    message += `• Всего шаблонов: ${templates.length}\n`;
    message += `• Категорий: ${categories.length}\n`;
    message += `• Использовано всего: ${templates.reduce((sum, t) => sum + t.usageCount, 0)} раз\n\n`;
    
    if (paginatedTemplates.length === 0) {
      message += `📭 <b>Шаблоны не найдены</b>\n`;
      message += `Создайте свой первый шаблон ответа!\n\n`;
    } else {
      message += `📋 <b>Шаблоны (страница ${page}/${totalPages}):</b>\n\n`;
      
      paginatedTemplates.forEach((template, index) => {
        const globalIndex = startIndex + index + 1;
        message += `<b>${globalIndex}. ${template.title}</b>\n`;
        message += `📁 Категория: ${template.category}\n`;
        message += `🏷️ Теги: ${template.tags.join(', ')}\n`;
        message += `📊 Использовано: ${template.usageCount} раз\n`;
        
        // Обрезаем текст для отображения
        const previewText = template.text.length > 80 ? 
          template.text.substring(0, 80) + '...' : template.text;
        message += `💬 ${previewText}\n`;
        
        message += `────────────────────\n`;
      });
    }
    
    message += `\n💡 <b>Рекомендации:</b>\n`;
    message += `• Шаблоны экономят время при ответах на частые вопросы\n`;
    message += `• Используйте категории для удобной организации\n`;
    message += `• Регулярно обновляйте шаблоны\n`;

    // Создаем клавиатуру
    const keyboardButtons = [];
    
    // Кнопки для пагинации
    const paginationRow = [];
    if (page > 1) {
      paginationRow.push(Markup.button.callback('⬅️ Назад', `admin_templates_page_${page - 1}`));
    }
    if (page < totalPages) {
      paginationRow.push(Markup.button.callback('Вперед ➡️', `admin_templates_page_${page + 1}`));
    }
    if (paginationRow.length > 0) {
      keyboardButtons.push(paginationRow);
    }
    
    // Основные кнопки
    keyboardButtons.push([
      Markup.button.callback('➕ Создать шаблон', 'admin_template_create'),
      Markup.button.callback('📁 Категории', 'admin_templates_categories')
    ]);
    
    keyboardButtons.push([
      Markup.button.callback('🔄 Обновить', `admin_templates_refresh_${page}`),
      Markup.button.callback('📤 Экспорт', 'admin_templates_export')
    ]);
    
    keyboardButtons.push([
      Markup.button.callback('🔙 Назад в настройки', 'admin_settings')
    ]);

    const keyboard = Markup.inlineKeyboard(keyboardButtons);

    if (ctx.updateType === 'callback_query') {
      try {
        await ctx.editMessageText(message, {
          parse_mode: 'HTML',
          ...keyboard
        });
        await ctx.answerCbQuery();
        return true;
      } catch (editError) {
        if (editError.response && editError.response.description && 
            editError.response.description.includes('message is not modified')) {
          console.log('ℹ️ Сообщение не изменилось, пропускаем ошибку');
          await ctx.answerCbQuery();
          return true;
        }
        throw editError;
      }
    } else {
      await ctx.replyWithHTML(message, keyboard);
      return true;
    }

  } catch (error) {
    console.error('Ошибка при отображении шаблонов ответов:', error);
    addToSystemLog(`Ошибка при отображении шаблонов ответов: ${error.message}`, 'ERROR');
    
    await ctx.editMessageText(
      '❌ <b>Ошибка при загрузке шаблонов ответов</b>\n\n' +
      `Не удалось загрузить шаблоны: ${error.message}`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Повторить', 'admin_settings_templates')],
          [Markup.button.callback('🔙 Назад', 'admin_settings')]
        ])
      }
    );
    return false;
  }
}

// Функция для создания шаблона
async function showTemplateCreation(ctx) {
  try {
    const ADMIN_ID = 1427347068;
    if (ctx.from.id !== ADMIN_ID) return;

    await ctx.editMessageText(
      '➕ <b>СОЗДАНИЕ НОВОГО ШАБЛОНА</b>\n\n' +
      
      '📝 <b>Инструкция:</b>\n' +
      'Шаблон должен содержать заголовок и текст. Текст может включать HTML-разметку для форматирования.\n\n' +
      
      '💡 <b>Пример структуры:</b>\n' +
      'Заголовок: Ответ на вопрос о зуде\n' +
      'Категория: проблемы\n' +
      'Теги: зуд, рекомендации, проблемы\n' +
      'Текст: Сильный зуд после нанесения татуировки - это нормально! Не чешите татуировку...\n\n' +
      
      '⚠️ <b>Важно:</b>\n' +
      '• Заголовок должен быть кратким и понятным\n' +
      '• Текст должен быть информативным и полезным\n' +
      '• Используйте категории для организации\n' +
      '• Теги помогают быстрому поиску\n\n' +
      
      '📝 <b>Отправьте шаблон в формате:</b>\n' +
      '```\n' +
      'Заголовок: Ваш заголовок\n' +
      'Категория: уход\n' +
      'Теги: уход, рекомендации, первые дни\n' +
      'Текст: Ваш текст шаблона...\n' +
      '```\n\n' +
      
      '❌ <b>Для отмены отправьте "отмена"</b>',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Назад к шаблонам', 'admin_settings_templates')]
        ])
      }
    );

    // Устанавливаем состояние ожидания шаблона
    await ctx.db.User.updateOne(
      { telegramId: ctx.from.id },
      { $set: { stage: 'awaiting_template' } }
    );

  } catch (error) {
    console.error('Ошибка при создании шаблона:', error);
    await ctx.answerCbQuery('❌ Ошибка');
  }
}

// Функция для отображения категорий
async function showTemplateCategories(ctx) {
  try {
    const ADMIN_ID = 1427347068;
    if (ctx.from.id !== ADMIN_ID) return;

    if (!systemCache.templates) {
      systemCache.templates = { templates: [], categories: [], lastUpdated: new Date() };
    }

    const categories = systemCache.templates.categories;
    const templates = systemCache.templates.templates;

    // Считаем количество шаблонов в каждой категории
    const categoryStats = {};
    categories.forEach(cat => {
      categoryStats[cat] = templates.filter(t => t.category === cat).length;
    });

    let message = '📁 <b>КАТЕГОРИИ ШАБЛОНОВ</b>\n\n';
    
    message += `📊 <b>Статистика по категориям:</b>\n`;
    categories.forEach(cat => {
      message += `• ${cat}: ${categoryStats[cat] || 0} шаблонов\n`;
    });
    
    if (categories.length === 0) {
      message += '\n📭 Категории не созданы\n';
    }
    
    message += `\n💡 <b>Доступные действия:</b>\n`;
    message += `• Добавить новую категорию\n`;
    message += `• Переименовать существующую\n`;
    message += `• Удалить категорию\n`;
    message += `• Переместить шаблоны между категориями\n`;

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('➕ Добавить категорию', 'admin_category_add'),
        Markup.button.callback('✏️ Переименовать', 'admin_category_rename')
      ],
      [
        Markup.button.callback('🗑️ Удалить категорию', 'admin_category_delete'),
        Markup.button.callback('🔄 Переместить шаблоны', 'admin_category_move')
      ],
      [
        Markup.button.callback('📊 Статистика', 'admin_categories_stats'),
        Markup.button.callback('🔄 Обновить', 'admin_categories_refresh')
      ],
      [
        Markup.button.callback('🔙 Назад к шаблонам', 'admin_settings_templates')
      ]
    ]);

    await ctx.editMessageText(message, {
      parse_mode: 'HTML',
      ...keyboard
    });
    await ctx.answerCbQuery();

  } catch (error) {
    console.error('Ошибка при отображении категорий:', error);
    await ctx.answerCbQuery('❌ Ошибка');
  }
}

// ========== ФУНКЦИЯ ДЛЯ УПРАВЛЕНИЯ ДОСТУПОМ АДМИНИСТРАТОРОВ ==========

async function showAccessSettings(ctx, isRefresh = false) {
  try {
    const ADMIN_ID = 1427347068;
    if (ctx.from.id !== ADMIN_ID) return;

    console.log(`🔐 Админ ${ctx.from.id} открыл управление доступом`);
    
    // Проверяем, есть ли настройки доступа в systemCache
    if (!systemCache.accessSettings) {
      // Получаем текущий username главного администратора
      const mainAdminUsername = ctx.from.username || 'vladislavvodolazskiy';
      
      systemCache.accessSettings = {
        admins: [
          {
            id: ADMIN_ID,
            name: "Главный администратор",
            username: mainAdminUsername,
            addedAt: new Date(),
            permissions: {
              fullAccess: true,
              canManageUsers: true,
              canManageQuestions: true,
              canManageSettings: true,
              canSendBroadcasts: true,
              canViewAnalytics: true
            }
          }
        ],
        maxAdmins: 5,
        lastUpdated: new Date()
      };
    } else {
      // Обновляем username главного администратора, если он изменился
      const mainAdmin = systemCache.accessSettings.admins.find(a => a.id === ADMIN_ID);
      if (mainAdmin && ctx.from.username && mainAdmin.username !== ctx.from.username) {
        console.log(`🔄 Обновляю username главного администратора: ${mainAdmin.username} -> ${ctx.from.username}`);
        mainAdmin.username = ctx.from.username;
      }
    }

    const admins = systemCache.accessSettings.admins;
    const maxAdmins = systemCache.accessSettings.maxAdmins;
    const slotsAvailable = maxAdmins - admins.length;

    let message = '🔐 <b>УПРАВЛЕНИЕ ДОСТУПОМ АДМИНИСТРАТОРОВ</b>\n\n';
    
    if (isRefresh) {
      const updateTime = new Date();
      const timeString = updateTime.toLocaleTimeString('ru-RU');
      message += `🕒 <b>Обновлено:</b> ${timeString}\n\n`;
    }

    message += `📊 <b>Статистика:</b>\n`;
    message += `• Всего администраторов: ${admins.length}\n`;
    message += `• Максимум доступно: ${maxAdmins}\n`;
    message += `• Свободных слотов: ${slotsAvailable}\n\n`;
    
    message += `👑 <b>ТЕКУЩИЕ АДМИНИСТРАТОРЫ:</b>\n\n`;
    
    if (admins.length === 0) {
      message += `❌ Нет администраторов\n`;
    } else {
      admins.forEach((admin, index) => {
        const isMainAdmin = admin.permissions?.fullAccess;
        const isCurrent = admin.id === ctx.from.id;
        const status = isMainAdmin ? '👑 Главный' : isCurrent ? '✅ Вы' : '🔧 Админ';
        
        message += `<b>${index + 1}. ${admin.name}</b>\n`;
        message += `ID: ${admin.id}\n`;
        
        // Исправляем отображение username
        if (admin.username) {
          // Если username начинается с @, убираем его
          const cleanUsername = admin.username.startsWith('@') 
            ? admin.username.substring(1) 
            : admin.username;
          message += `Username: @${cleanUsername}\n`;
        } else {
          message += `Username: не указан\n`;
        }
        
        message += `Статус: ${status}\n`;
        
        if (admin.addedAt) {
          const dateStr = admin.addedAt.toLocaleDateString('ru-RU');
          message += `Добавлен: ${dateStr}\n`;
        }
        
        // Права доступа
        if (admin.permissions) {
          const permissions = [];
          if (admin.permissions.canManageUsers) permissions.push('👥 Пользователи');
          if (admin.permissions.canManageQuestions) permissions.push('❓ Вопросы');
          if (admin.permissions.canManageSettings) permissions.push('⚙️ Настройки');
          if (admin.permissions.canSendBroadcasts) permissions.push('📢 Рассылки');
          if (admin.permissions.canViewAnalytics) permissions.push('📊 Аналитика');
          
          if (permissions.length > 0) {
            message += `Права: ${permissions.join(', ')}\n`;
          }
        }
        
        message += `────────────────────\n`;
      });
    }
    
    message += `\n💡 <b>ИНСТРУКЦИЯ:</b>\n`;
    message += `• Только главный администратор может управлять доступом\n`;
    message += `• Для добавления администратора нужно знать его Telegram ID\n`;
    message += `• Каждый администратор получает выбранные права доступа\n`;
    message += `• Рекомендуется добавлять только доверенных лиц`;

    // Создаем клавиатуру
    const keyboardButtons = [];
    
    // Только главный администратор может добавлять новых
    const isMainAdmin = admins.find(a => a.id === ctx.from.id)?.permissions?.fullAccess;
    
    if (isMainAdmin && slotsAvailable > 0) {
      keyboardButtons.push([
        Markup.button.callback('➕ Добавить администратора', 'admin_access_add')
      ]);
    }
    
    if (admins.length > 1) {
      keyboardButtons.push([
        Markup.button.callback('🗑️ Удалить администратора', 'admin_access_remove_list')
      ]);
    }
    
    keyboardButtons.push([
      Markup.button.callback('🔧 Настроить права', 'admin_access_permissions'),
      Markup.button.callback('📋 Список прав', 'admin_access_list_permissions')
    ]);
    
    keyboardButtons.push([
      Markup.button.callback('🔄 Обновить', 'admin_access_refresh'),
      Markup.button.callback('📊 Лог действий', 'admin_access_log')
    ]);
    
    keyboardButtons.push([
      Markup.button.callback('🔙 Назад в настройки', 'admin_settings')
    ]);

    const keyboard = Markup.inlineKeyboard(keyboardButtons);

    if (ctx.updateType === 'callback_query') {
      try {
        await ctx.editMessageText(message, {
          parse_mode: 'HTML',
          ...keyboard
        });
        await ctx.answerCbQuery();
        return true;
      } catch (editError) {
        if (editError.response && editError.response.description && 
            editError.response.description.includes('message is not modified')) {
          console.log('ℹ️ Сообщение не изменилось, пропускаем ошибку');
          await ctx.answerCbQuery();
          return true;
        }
        throw editError;
      }
    } else {
      await ctx.replyWithHTML(message, keyboard);
      return true;
    }

  } catch (error) {
    console.error('Ошибка при отображении управления доступом:', error);
    addToSystemLog(`Ошибка при отображении управления доступом: ${error.message}`, 'ERROR');
    
    await ctx.editMessageText(
      '❌ <b>Ошибка при загрузке управления доступом</b>\n\n' +
      `Не удалось загрузить настройки: ${error.message}`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Повторить', 'admin_settings_access')],
          [Markup.button.callback('🔙 Назад', 'admin_settings')]
        ])
      }
    );
    return false;
  }
}

// Функция для показа диалога добавления администратора
async function showAddAdminDialog(ctx) {
  try {
    const ADMIN_ID = 1427347068;
    if (ctx.from.id !== ADMIN_ID) return;

    // Проверяем, может ли текущий администратор добавлять других
    if (!systemCache.accessSettings) {
      await showAccessSettings(ctx);
      return;
    }
    
    const currentAdmin = systemCache.accessSettings.admins.find(a => a.id === ctx.from.id);
    if (!currentAdmin?.permissions?.fullAccess) {
      await ctx.answerCbQuery('❌ Только главный администратор может добавлять других');
      return;
    }
    
    const slotsAvailable = systemCache.accessSettings.maxAdmins - systemCache.accessSettings.admins.length;
    if (slotsAvailable <= 0) {
      await ctx.answerCbQuery(`❌ Достигнут максимум администраторов (${systemCache.accessSettings.maxAdmins})`);
      return;
    }

    await ctx.editMessageText(
      '➕ <b>ДОБАВЛЕНИЕ НОВОГО АДМИНИСТРАТОРА</b>\n\n' +
      
      '📝 <b>Инструкция:</b>\n' +
      'Для добавления нового администратора необходимо знать его Telegram ID.\n\n' +
      
      '🔍 <b>Как найти ID пользователя:</b>\n' +
      '1. Попросите пользователя отправить боту любое сообщение\n' +
      '2. Используйте команду /debug или /stats для просмотра ID\n' +
      '3. Или используйте специального бота для получения ID\n\n' +
      
      '📋 <b>Формат добавления:</b>\n' +
      'Отправьте ID нового администратора в формате:\n' +
      '```\n' +
      '123456789\n' +
      '```\n' +
      'Где 123456789 - Telegram ID пользователя\n\n' +
      
      '⚠️ <b>Важные моменты:</b>\n' +
      '• Пользователь должен уже начать диалог с ботом\n' +
      '• ID должен быть числом\n' +
      '• Нельзя добавить уже существующего администратора\n\n' +
      
      '❌ <b>Для отмены отправьте "отмена"</b>',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Назад к управлению доступом', 'admin_settings_access')]
        ])
      }
    );

    // Устанавливаем состояние ожидания ID администратора
    await ctx.db.User.updateOne(
      { telegramId: ctx.from.id },
      { $set: { stage: 'awaiting_admin_id' } }
    );

    await ctx.answerCbQuery();

  } catch (error) {
    console.error('Ошибка при отображении диалога добавления:', error);
    await ctx.answerCbQuery('❌ Ошибка');
  }
}

// ========== ФУНКЦИЯ ДЛЯ ПРОСМОТРА ЛОГА ДЕЙСТВИЙ АДМИНИСТРАТОРОВ ==========

async function showAccessLog(ctx, page = 1, isRefresh = false) {
  try {
    const ADMIN_ID = 1427347068;
    if (ctx.from.id !== ADMIN_ID) return;

    console.log(`📝 Админ ${ctx.from.id} открыл лог действий администраторов`);
    
    // Фильтруем логи действий администраторов из systemCache.actionLog
    const adminLogs = systemCache.actionLog.filter(log => 
      log.type === 'ADMIN_ACTION' || 
      (log.adminId && (log.message && log.message.includes('админ') || log.action && log.action.includes('админ')))
    );
    
    // Сортируем по дате (новые сверху)
    adminLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    const logsPerPage = 10;
    const totalLogs = adminLogs.length;
    const totalPages = Math.ceil(totalLogs / logsPerPage) || 1;
    const startIndex = (page - 1) * logsPerPage;
    const endIndex = startIndex + logsPerPage;
    const logsToShow = adminLogs.slice(startIndex, endIndex);

    let message = `📝 <b>ЛОГ ДЕЙСТВИЙ АДМИНИСТРАТОРОВ</b>\n\n`;
    
    if (isRefresh) {
      const updateTime = new Date();
      const timeString = updateTime.toLocaleTimeString('ru-RU');
      message += `🕒 <b>Обновлено:</b> ${timeString}\n\n`;
    }

    message += `📊 <b>Статистика:</b>\n`;
    message += `• Всего записей: ${totalLogs}\n`;
    message += `• Страница: ${page}/${totalPages}\n\n`;
    
    if (logsToShow.length === 0) {
      message += `📭 Нет записей о действиях администраторов.\n`;
    } else {
      message += `<b>ПОСЛЕДНИЕ ДЕЙСТВИЯ:</b>\n\n`;
      
      logsToShow.forEach((log, index) => {
        const logNumber = startIndex + index + 1;
        const time = log.timestamp ? new Date(log.timestamp).toLocaleTimeString('ru-RU') : 'н/д';
        const date = log.timestamp ? new Date(log.timestamp).toLocaleDateString('ru-RU') : 'н/д';
        
        message += `<b>${logNumber}. ${time}</b>\n`;
        message += `📅 ${date}\n`;
        
        if (log.adminId) {
          message += `👑 Админ ID: ${log.adminId}\n`;
        }
        
        if (log.action) {
          message += `📝 Действие: ${log.action}\n`;
        }
        
        if (log.message) {
          // Обрезаем длинные сообщения
          const logMessage = log.message.length > 80 ? 
            log.message.substring(0, 80) + '...' : log.message;
          message += `💬 ${logMessage}\n`;
        }
        
        message += `────────────────────\n`;
      });
    }
    
    message += `\n💡 <b>ИНФОРМАЦИЯ:</b>\n`;
    message += `• Здесь отображаются все действия, связанные с управлением доступом\n`;
    message += `• Логи хранятся только в оперативной памяти и сбрасываются при перезапуске\n`;
    message += `• Для постоянного хранения логов нужна интеграция с внешним сервисом`;

    // Создаем клавиатуру с пагинацией
    const keyboardButtons = [];
    
    // Кнопки пагинации
    const navRow = [];
    if (page > 1) {
      navRow.push(Markup.button.callback('⬅️ Назад', `admin_access_log_page_${page - 1}`));
    }
    
    if (page < totalPages) {
      navRow.push(Markup.button.callback('Вперед ➡️', `admin_access_log_page_${page + 1}`));
    }
    
    if (navRow.length > 0) {
      keyboardButtons.push(navRow);
    }
    
    // Кнопки действий
    keyboardButtons.push([
      Markup.button.callback('🔄 Обновить', `admin_access_log_refresh_${page}`),
      Markup.button.callback('🧹 Очистить логи', 'admin_access_log_clear_confirm')
    ]);
    
    keyboardButtons.push([
      Markup.button.callback('🔙 Назад к управлению доступом', 'admin_settings_access')
    ]);

    const keyboard = Markup.inlineKeyboard(keyboardButtons);

    if (ctx.updateType === 'callback_query') {
      try {
        await ctx.editMessageText(message, {
          parse_mode: 'HTML',
          ...keyboard
        });
        await ctx.answerCbQuery();
        return true;
      } catch (editError) {
        if (editError.response && editError.response.description && 
            editError.response.description.includes('message is not modified')) {
          console.log('ℹ️ Сообщение не изменилось, пропускаем ошибку');
          await ctx.answerCbQuery();
          return true;
        }
        throw editError;
      }
    } else {
      await ctx.replyWithHTML(message, keyboard);
      return true;
    }

  } catch (error) {
    console.error('Ошибка при отображении лога действий:', error);
    
    await ctx.editMessageText(
      '❌ <b>Ошибка при загрузке лога действий</b>\n\n' +
      `Не удалось загрузить логи: ${error.message}`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Повторить', 'admin_access_log')],
          [Markup.button.callback('🔙 Назад', 'admin_settings_access')]
        ])
      }
    );
    return false;
  }
}

// Функция для подтверждения очистки лога
async function confirmClearAccessLog(ctx) {
  try {
    const ADMIN_ID = 1427347068;
    if (ctx.from.id !== ADMIN_ID) return;

    await ctx.editMessageText(
      '⚠️ <b>ПОДТВЕРЖДЕНИЕ ОЧИСТКИ ЛОГА</b>\n\n' +
      'Вы уверены, что хотите очистить лог действий администраторов?\n\n' +
      '📊 <b>Текущая статистика:</b>\n' +
      `• Записей в логе: ${systemCache.actionLog.length}\n\n` +
      '❌ <b>Внимание:</b> Это действие нельзя отменить!\n' +
      'Все записи будут удалены без возможности восстановления.\n\n' +
      '✅ <b>Подтвердите очистку:</b>',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Да, очистить', 'admin_access_log_clear'),
            Markup.button.callback('❌ Нет, отмена', 'admin_access_log')
          ]
        ])
      }
    );

    await ctx.answerCbQuery();

  } catch (error) {
    console.error('Ошибка при подтверждении очистки лога:', error);
    await ctx.answerCbQuery('❌ Ошибка');
  }
}

// Функция для очистки лога
async function clearAccessLog(ctx) {
  try {
    const ADMIN_ID = 1427347068;
    if (ctx.from.id !== ADMIN_ID) return;

    const logCount = systemCache.actionLog.length;
    
    // Очищаем лог
    systemCache.actionLog = [];
    
    addToSystemLog(`Админ ${ctx.from.id} очистил лог действий администраторов (удалено ${logCount} записей)`, 'ADMIN_ACTION');
    
    await ctx.answerCbQuery(`✅ Лог очищен (удалено ${logCount} записей)`);
    await showAccessLog(ctx, 1, true);

  } catch (error) {
    console.error('Ошибка при очистке лога:', error);
    await ctx.answerCbQuery('❌ Ошибка при очистке');
  }
}

// Функция для отображения графика роста пользователей
async function showUsersGrowthChart(ctx, period = '7days', isRefresh = false) {
  try {
    const ADMIN_ID = 1427347068;
    if (ctx.from.id !== ADMIN_ID) return;

    addToSystemLog(`Админ ${ctx.from.id} запросил график роста пользователей (период: ${period})`, 'ADMIN_ACTION');

    // Определяем период
    let days, periodName;
    switch (period) {
      case '7days':
        days = 7;
        periodName = '7 дней';
        break;
      case '30days':
        days = 30;
        periodName = '30 дней';
        break;
      case '90days':
        days = 90;
        periodName = '90 дней';
        break;
      default:
        days = 7;
        periodName = '7 дней';
    }

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // Получаем данные о регистрациях по дням
    const registrationsByDay = await ctx.db.User.aggregate([
      {
        $match: {
          createdAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
            day: { $dayOfMonth: '$createdAt' }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }
    ]);

    // Подготавливаем данные для графика
    let chartData = [];
    let maxCount = 0;
    let total = 0;

    // Заполняем все дни периода
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
      
      // Ищем данные для этого дня
      const dayData = registrationsByDay.find(item => 
        item._id.day === date.getDate() && 
        item._id.month === date.getMonth() + 1 &&
        item._id.year === date.getFullYear()
      );
      
      const count = dayData ? dayData.count : 0;
      chartData.push({ date: dateStr, count });
      maxCount = Math.max(maxCount, count);
      total += count;
    }

    // Строим ASCII график
    let chart = '';
    const maxBarLength = 20;
    
    chartData.forEach(item => {
      const barLength = maxCount > 0 ? Math.round((item.count / maxCount) * maxBarLength) : 0;
      const bar = '█'.repeat(barLength) + '░'.repeat(maxBarLength - barLength);
      chart += `${item.date}: ${bar} ${item.count}\n`;
    });

    // Формируем сообщение
    let message = `📈 <b>РОСТ ПОЛЬЗОВАТЕЛЕЙ (${periodName})</b>\n\n`;
    
    // Добавляем время обновления при refresh
    if (isRefresh) {
      const updateTime = new Date();
      const timeString = updateTime.toLocaleTimeString('ru-RU');
      message += `🕒 <b>Обновлено:</b> ${timeString}\n\n`;
    }
    
    message += `📅 Период: ${startDate.toLocaleDateString('ru-RU')} - ${endDate.toLocaleDateString('ru-RU')}\n`;
    message += `👥 Всего новых: ${total}\n`;
    message += `📊 Среднее в день: ${(total / days).toFixed(1)}\n\n`;
    message += `<pre>${chart}</pre>\n`;
    message += `📋 <b>Статистика:</b>\n`;
    message += `• Максимум в день: ${maxCount}\n`;
    message += `• Дней без регистраций: ${chartData.filter(item => item.count === 0).length}\n`;
    
    // Находим самый активный день
    const mostActiveDay = chartData.reduce((max, item) => item.count > max.count ? item : max, {count: 0});
    message += `• Самый активный день: ${mostActiveDay.date} (${mostActiveDay.count})\n\n`;

    // Создаем клавиатуру с выбором периода
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(period === '7days' ? '✅ 7 дней' : '7 дней', 'chart_users_7days'),
        Markup.button.callback(period === '30days' ? '✅ 30 дней' : '30 дней', 'chart_users_30days'),
        Markup.button.callback(period === '90days' ? '✅ 90 дней' : '90 дней', 'chart_users_90days')
      ],
      [
        Markup.button.callback('🔄 Обновить', `chart_users_refresh_${period}`),
        Markup.button.callback('📊 Другие графики', 'admin_charts')
      ],
      [
        Markup.button.callback('🔙 Назад к аналитике', 'admin_analytics')
      ]
    ]);

    if (ctx.updateType === 'callback_query') {
      try {
        await ctx.editMessageText(message, {
          parse_mode: 'HTML',
          ...keyboard
        });
        await ctx.answerCbQuery();
        return true;
      } catch (editError) {
        // Если ошибка "message not modified", просто игнорируем
        if (editError.response && editError.response.description && 
            editError.response.description.includes('message is not modified')) {
          console.log('ℹ️ Сообщение не изменилось, пропускаем ошибку');
          await ctx.answerCbQuery();
          return true;
        }
        throw editError;
      }
    } else {
      await ctx.replyWithHTML(message, keyboard);
      return true;
    }

  } catch (error) {
    console.error('Ошибка при построении графика роста:', error);
    addToSystemLog(`Ошибка при построении графика роста: ${error.message}`, 'ERROR');
    
    const errorMessage = `❌ <b>Ошибка при построении графика</b>\n\n` +
      `Не удалось получить данные: ${error.message}`;
    
    if (ctx.updateType === 'callback_query') {
      try {
        await ctx.editMessageText(errorMessage, {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Повторить', 'chart_users_growth')],
            [Markup.button.callback('🔙 Назад', 'admin_charts')]
          ])
        });
        await ctx.answerCbQuery('❌ Ошибка');
      } catch (editError) {
        await ctx.answerCbQuery('❌ Ошибка загрузки');
      }
    } else {
      await ctx.reply(errorMessage);
    }
    return false;
  }
}

// Функция для отображения графика ежедневной активности
async function showDailyActivityChart(ctx, period = '7days', isRefresh = false) {
  try {
    const ADMIN_ID = 1427347068;
    if (ctx.from.id !== ADMIN_ID) return;

    addToSystemLog(`Админ ${ctx.from.id} запросил график ежедневной активности (период: ${period})`, 'ADMIN_ACTION');

    // Определяем период
    let days, periodName;
    switch (period) {
      case '7days':
        days = 7;
        periodName = '7 дней';
        break;
      case '30days':
        days = 30;
        periodName = '30 дней';
        break;
      case '90days':
        days = 90;
        periodName = '90 дней';
        break;
      default:
        days = 7;
        periodName = '7 дней';
    }

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // Получаем данные об активности по дням
    // Активным считаем пользователя, если его lastActive был в этот день
    const activityByDay = await ctx.db.User.aggregate([
      {
        $match: {
          lastActive: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$lastActive' },
            month: { $month: '$lastActive' },
            day: { $dayOfMonth: '$lastActive' }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }
    ]);

    // Подготавливаем данные для графика
    let chartData = [];
    let maxCount = 0;
    let totalActive = 0;

    // Заполняем все дни периода
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toLocaleDateString('ru-RU', { 
        weekday: 'short',
        day: '2-digit', 
        month: '2-digit' 
      });
      
      // Ищем данные для этого дня
      const dayData = activityByDay.find(item => 
        item._id.day === date.getDate() && 
        item._id.month === date.getMonth() + 1 &&
        item._id.year === date.getFullYear()
      );
      
      const count = dayData ? dayData.count : 0;
      chartData.push({ 
        date: dateStr, 
        count,
        fullDate: date
      });
      maxCount = Math.max(maxCount, count);
      totalActive += count;
    }

    // Получаем общее количество пользователей для статистики
    const totalUsers = await ctx.db.User.countDocuments({});
    const activeRate = totalUsers > 0 ? ((totalActive / (days * totalUsers)) * 100).toFixed(1) : 0;

    // Строим ASCII график
    let chart = '';
    const maxBarLength = 20;
    
    chartData.forEach(item => {
      const barLength = maxCount > 0 ? Math.round((item.count / maxCount) * maxBarLength) : 0;
      const bar = '█'.repeat(barLength) + '░'.repeat(maxBarLength - barLength);
      chart += `${item.date}: ${bar} ${item.count}\n`;
    });

    // Формируем сообщение
    let message = `📅 <b>ЕЖЕДНЕВНАЯ АКТИВНОСТЬ (${periodName})</b>\n\n`;
    
    // Добавляем время обновления при refresh
    if (isRefresh) {
      const updateTime = new Date();
      const timeString = updateTime.toLocaleTimeString('ru-RU');
      message += `🕒 <b>Обновлено:</b> ${timeString}\n\n`;
    }
    
    message += `📅 Период: ${startDate.toLocaleDateString('ru-RU')} - ${endDate.toLocaleDateString('ru-RU')}\n`;
    message += `👥 Всего пользователей: ${totalUsers}\n`;
    message += `📈 Активных действий: ${totalActive}\n`;
    message += `📊 Средняя активность в день: ${(totalActive / days).toFixed(1)}\n`;
    message += `🎯 Процент активности: ${activeRate}%\n\n`;
    
    message += `<pre>${chart}</pre>\n`;
    
    message += `📋 <b>Статистика активности:</b>\n`;
    message += `• Максимум в день: ${maxCount}\n`;
    message += `• Дней без активности: ${chartData.filter(item => item.count === 0).length}\n`;
    
    // Находим самый активный день
    const mostActiveDay = chartData.reduce((max, item) => item.count > max.count ? item : max, {count: 0});
    message += `• Самый активный день: ${mostActiveDay.date} (${mostActiveDay.count} действий)\n`;
    
    // Рассчитываем среднюю активность по дням недели
    const weekdays = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
    const weekdayStats = {};
    chartData.forEach(item => {
      const weekday = weekdays[item.fullDate.getDay()];
      weekdayStats[weekday] = (weekdayStats[weekday] || 0) + item.count;
    });
    
    // Находим самый активный день недели
    let mostActiveWeekday = 'Н/Д';
    let maxWeekdayCount = 0;
    Object.entries(weekdayStats).forEach(([weekday, count]) => {
      if (count > maxWeekdayCount) {
        maxWeekdayCount = count;
        mostActiveWeekday = weekday;
      }
    });
    
    message += `• Самый активный день недели: ${mostActiveWeekday}\n`;
    message += `• Всего уникальных активных дней: ${activityByDay.length}\n\n`;

    // Создаем клавиатуру с выбором периода
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(period === '7days' ? '✅ 7 дней' : '7 дней', 'chart_daily_7days'),
        Markup.button.callback(period === '30days' ? '✅ 30 дней' : '30 дней', 'chart_daily_30days'),
        Markup.button.callback(period === '90days' ? '✅ 90 дней' : '90 дней', 'chart_daily_90days')
      ],
      [
        Markup.button.callback('🔄 Обновить', `chart_daily_refresh_${period}`),
        Markup.button.callback('📈 Рост пользователей', 'chart_users_growth')
      ],
      [
        Markup.button.callback('📊 Другие графики', 'admin_charts'),
        Markup.button.callback('🔙 Назад к аналитике', 'admin_analytics')
      ]
    ]);

    if (ctx.updateType === 'callback_query') {
      try {
        await ctx.editMessageText(message, {
          parse_mode: 'HTML',
          ...keyboard
        });
        await ctx.answerCbQuery();
        return true;
      } catch (editError) {
        // Если ошибка "message not modified", просто игнорируем
        if (editError.response && editError.response.description && 
            editError.response.description.includes('message is not modified')) {
          console.log('ℹ️ Сообщение не изменилось, пропускаем ошибку');
          await ctx.answerCbQuery();
          return true;
        }
        throw editError;
      }
    } else {
      await ctx.replyWithHTML(message, keyboard);
      return true;
    }

  } catch (error) {
    console.error('Ошибка при построении графика активности:', error);
    addToSystemLog(`Ошибка при построении графика активности: ${error.message}`, 'ERROR');
    
    const errorMessage = `❌ <b>Ошибка при построении графика активности</b>\n\n` +
      `Не удалось получить данные: ${error.message}`;
    
    if (ctx.updateType === 'callback_query') {
      try {
        await ctx.editMessageText(errorMessage, {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Повторить', 'chart_daily_activity')],
            [Markup.button.callback('🔙 Назад', 'admin_charts')]
          ])
        });
        await ctx.answerCbQuery('❌ Ошибка');
      } catch (editError) {
        await ctx.answerCbQuery('❌ Ошибка загрузки');
      }
    } else {
      await ctx.reply(errorMessage);
    }
    return false;
  }
}

// Функция для безопасной очистки системного кэша
async function clearSystemCache(ctx) {
  try {
    console.log(`🧹 Админ ${ctx.from.id} начал очистку системного кэша`);
    
    // Добавляем лог
    addToSystemLog(`Админ ${ctx.from.id} начал очистку системного кэша`, 'CACHE');

    // Сохраняем предыдущее состояние для отчета
    const previousState = {
      hadUserList: systemCache.userList !== null,
      hadQuestionList: systemCache.questionList !== null,
      hadStats: systemCache.stats !== null,
      lastUpdated: systemCache.lastUpdated
    };
    
    // Очищаем кэш
    systemCache.userList = null;
    systemCache.questionList = null;
    systemCache.stats = null;
    systemCache.lastUpdated = null;
    
    // Добавляем запись в лог действий (простой массив)
    systemCache.actionLog.push({
      timestamp: new Date(),
      action: 'cache_clear',
      adminId: ctx.from.id,
      previousState: previousState
    });
    
    // Ограничиваем размер лога действий
    if (systemCache.actionLog.length > 50) {
      systemCache.actionLog.shift();
    }
    
    console.log(`✅ Кэш успешно очищен администратором ${ctx.from.id}`);
    addToSystemLog(`Кэш успешно очищен администратором ${ctx.from.id}. Очищено: ${result.clearedItems.join(', ')}`, 'CACHE');
    return {
      success: true,
      clearedItems: [
        previousState.hadUserList ? 'Кэш пользователей' : null,
        previousState.hadQuestionList ? 'Кэш вопросов' : null,
        previousState.hadStats ? 'Кэш статистики' : null
      ].filter(item => item !== null)
    };
    
  } catch (error) {
    console.error('❌ Ошибка при очистке кэша:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Функция для отображения графика вопросов пользователей
async function showQuestionsChart(ctx, period = '7days', isRefresh = false) {
  try {
    const ADMIN_ID = 1427347068;
    if (ctx.from.id !== ADMIN_ID) return;

    addToSystemLog(`Админ ${ctx.from.id} запросил график вопросов (период: ${period})`, 'ADMIN_ACTION');

    // Определяем период
    let days, periodName;
    switch (period) {
      case '7days':
        days = 7;
        periodName = '7 дней';
        break;
      case '30days':
        days = 30;
        periodName = '30 дней';
        break;
      case '90days':
        days = 90;
        periodName = '90 дней';
        break;
      default:
        days = 7;
        periodName = '7 дней';
    }

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // Получаем всех пользователей с вопросами за период
    const allUsers = await ctx.db.User.find({
      'questions.date': { $gte: startDate, $lte: endDate }
    });

    // Собираем все вопросы за период
    let allQuestions = [];
    let questionsByDay = {};
    
    // Инициализируем объект для каждого дня
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      date.setHours(0, 0, 0, 0);
      const dateKey = date.toISOString().split('T')[0];
      questionsByDay[dateKey] = { count: 0, pending: 0, answered: 0 };
    }

    // Обрабатываем вопросы каждого пользователя
    allUsers.forEach(user => {
      if (user.questions && Array.isArray(user.questions)) {
        user.questions.forEach(question => {
          if (question.date && question.date >= startDate && question.date <= endDate) {
            const questionDate = new Date(question.date);
            questionDate.setHours(0, 0, 0, 0);
            const dateKey = questionDate.toISOString().split('T')[0];
            
            if (questionsByDay[dateKey]) {
              questionsByDay[dateKey].count++;
              
              if (question.status === 'pending') {
                questionsByDay[dateKey].pending++;
              } else if (question.status === 'answered') {
                questionsByDay[dateKey].answered++;
              }
              
              allQuestions.push({
                date: question.date,
                status: question.status || 'unknown',
                question: question.question ? question.question.substring(0, 100) : '',
                userId: user.telegramId
              });
            }
          }
        });
      }
    });

    // Подготавливаем данные для графика
    let chartData = [];
    let maxCount = 0;
    let totalQuestions = 0;
    let totalPending = 0;
    let totalAnswered = 0;

    // Заполняем данные для каждого дня
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toLocaleDateString('ru-RU', { 
        weekday: 'short',
        day: '2-digit', 
        month: '2-digit' 
      });
      
      const dateKey = date.toISOString().split('T')[0];
      const dayData = questionsByDay[dateKey] || { count: 0, pending: 0, answered: 0 };
      
      chartData.push({ 
        date: dateStr, 
        count: dayData.count,
        pending: dayData.pending,
        answered: dayData.answered,
        fullDate: date
      });
      
      maxCount = Math.max(maxCount, dayData.count);
      totalQuestions += dayData.count;
      totalPending += dayData.pending;
      totalAnswered += dayData.answered;
    }

    // Получаем статистику пользователей
    const totalUsers = await ctx.db.User.countDocuments({});
    const usersWithQuestions = await ctx.db.User.countDocuments({ 
      'questions.0': { $exists: true } 
    });
    
    const questionsPerUser = usersWithQuestions > 0 ? (totalQuestions / usersWithQuestions).toFixed(1) : 0;
    const answerRate = totalQuestions > 0 ? ((totalAnswered / totalQuestions) * 100).toFixed(1) : 0;

    // Строим ASCII график для общего количества вопросов
    let chart = '';
    const maxBarLength = 20;
    
    chartData.forEach(item => {
      const barLength = maxCount > 0 ? Math.round((item.count / maxCount) * maxBarLength) : 0;
      const bar = '█'.repeat(barLength) + '░'.repeat(maxBarLength - barLength);
      
      // Добавляем индикаторы статусов
      let statusIndicators = '';
      if (item.count > 0) {
        const pendingBar = item.pending > 0 ? '🟡' : '';
        const answeredBar = item.answered > 0 ? '🟢' : '';
        statusIndicators = ` ${pendingBar}${answeredBar}`;
      }
      
      chart += `${item.date}: ${bar} ${item.count}${statusIndicators}\n`;
    });

    // Формируем сообщение
    let message = `❓ <b>ГРАФИК ВОПРОСОВ ПОЛЬЗОВАТЕЛЕЙ (${periodName})</b>\n\n`;
    
    // Добавляем время обновления при refresh
    if (isRefresh) {
      const updateTime = new Date();
      const timeString = updateTime.toLocaleTimeString('ru-RU');
      message += `🕒 <b>Обновлено:</b> ${timeString}\n\n`;
    }
    
    message += `📅 Период: ${startDate.toLocaleDateString('ru-RU')} - ${endDate.toLocaleDateString('ru-RU')}\n`;
    message += `👥 Всего пользователей: ${totalUsers}\n`;
    message += `❓ Пользователей с вопросами: ${usersWithQuestions} (${totalUsers > 0 ? Math.round((usersWithQuestions / totalUsers) * 100) : 0}%)\n\n`;
    
    message += `📊 <b>Статистика вопросов:</b>\n`;
    message += `• Всего вопросов: ${totalQuestions}\n`;
    message += `• Среднее на пользователя: ${questionsPerUser}\n`;
    message += `• Ожидают ответа: ${totalPending}\n`;
    message += `• Отвечено: ${totalAnswered}\n`;
    message += `• Процент ответов: ${answerRate}%\n\n`;
    
    message += `<pre>${chart}</pre>\n`;
    message += `📈 <b>Расшифровка графика:</b>\n`;
    message += `• █ - вопросы за день\n`;
    message += `• 🟡 - есть ожидающие ответа\n`;
    message += `• 🟢 - есть отвеченные\n\n`;
    
    message += `📋 <b>Детальная статистика:</b>\n`;
    
    // Находим день с максимальным количеством вопросов
    const mostQuestionsDay = chartData.reduce((max, item) => item.count > max.count ? item : max, {count: 0});
    message += `• Максимум вопросов в день: ${mostQuestionsDay.date} (${mostQuestionsDay.count})\n`;
    
    // Дни без вопросов
    const daysWithoutQuestions = chartData.filter(item => item.count === 0).length;
    message += `• Дней без вопросов: ${daysWithoutQuestions}\n`;
    
    // Процент дней с вопросами
    const daysWithQuestions = days - daysWithoutQuestions;
    const daysWithQuestionsPercent = Math.round((daysWithQuestions / days) * 100);
    message += `• Дней с вопросами: ${daysWithQuestions} (${daysWithQuestionsPercent}%)\n`;
    
    // Среднее количество вопросов в дни с вопросами
    const avgQuestionsOnActiveDays = daysWithQuestions > 0 ? (totalQuestions / daysWithQuestions).toFixed(1) : 0;
    message += `• Среднее в дни с вопросами: ${avgQuestionsOnActiveDays}\n\n`;

    // Если есть вопросы, показываем топ пользователей
    if (allQuestions.length > 0) {
      // Группируем по пользователям для определения самых активных
      const userQuestionCount = {};
      allUsers.forEach(user => {
        if (user.questions && Array.isArray(user.questions)) {
          const userQuestionsInPeriod = user.questions.filter(q => 
            q.date && q.date >= startDate && q.date <= endDate
          ).length;
          if (userQuestionsInPeriod > 0) {
            userQuestionCount[user.telegramId] = {
              count: userQuestionsInPeriod,
              name: user.firstName || `ID:${user.telegramId}`
            };
          }
        }
      });
      
      // Находим топ-3 пользователей
      const topUsers = Object.values(userQuestionCount)
        .sort((a, b) => b.count - a.count)
        .slice(0, 3);
      
      if (topUsers.length > 0) {
        message += `👑 <b>Самые активные пользователи:</b>\n`;
        topUsers.forEach((user, index) => {
          message += `${index + 1}. ${user.name}: ${user.count} вопросов\n`;
        });
        message += `\n`;
      }
    }

    // Создаем клавиатуру с выбором периода
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(period === '7days' ? '✅ 7 дней' : '7 дней', 'chart_questions_7days'),
        Markup.button.callback(period === '30days' ? '✅ 30 дней' : '30 дней', 'chart_questions_30days'),
        Markup.button.callback(period === '90days' ? '✅ 90 дней' : '90 дней', 'chart_questions_90days')
      ],
      [
        Markup.button.callback('🔄 Обновить', `chart_questions_refresh_${period}`),
        Markup.button.callback('📅 Активность', 'chart_daily_activity')
      ],
      [
        Markup.button.callback('📊 Другие графики', 'admin_charts'),
        Markup.button.callback('🔙 Назад к аналитике', 'admin_analytics')
      ]
    ]);

    if (ctx.updateType === 'callback_query') {
      try {
        await ctx.editMessageText(message, {
          parse_mode: 'HTML',
          ...keyboard
        });
        await ctx.answerCbQuery();
        return true;
      } catch (editError) {
        // Если ошибка "message not modified", просто игнорируем
        if (editError.response && editError.response.description && 
            editError.response.description.includes('message is not modified')) {
          console.log('ℹ️ Сообщение не изменилось, пропускаем ошибку');
          await ctx.answerCbQuery();
          return true;
        }
        throw editError;
      }
    } else {
      await ctx.replyWithHTML(message, keyboard);
      return true;
    }

  } catch (error) {
    console.error('Ошибка при построении графика вопросов:', error);
    addToSystemLog(`Ошибка при построении графика вопросов: ${error.message}`, 'ERROR');
    
    const errorMessage = `❌ <b>Ошибка при построении графика вопросов</b>\n\n` +
      `Не удалось получить данные: ${error.message}`;
    
    if (ctx.updateType === 'callback_query') {
      try {
        await ctx.editMessageText(errorMessage, {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Повторить', 'chart_questions')],
            [Markup.button.callback('🔙 Назад', 'admin_charts')]
          ])
        });
        await ctx.answerCbQuery('❌ Ошибка');
      } catch (editError) {
        await ctx.answerCbQuery('❌ Ошибка загрузки');
      }
    } else {
      await ctx.reply(errorMessage);
    }
    return false;
  }
}

// Функция для отображения графика почасовой активности
async function showHourlyActivityChart(ctx, period = '7days', isRefresh = false) {
  try {
    const ADMIN_ID = 1427347068;
    if (ctx.from.id !== ADMIN_ID) return;

    addToSystemLog(`Админ ${ctx.from.id} запросил график почасовой активности (период: ${period})`, 'ADMIN_ACTION');

    // Определяем период
    let days, periodName;
    switch (period) {
      case '7days':
        days = 7;
        periodName = '7 дней';
        break;
      case '30days':
        days = 30;
        periodName = '30 дней';
        break;
      case '90days':
        days = 90;
        periodName = '90 дней';
        break;
      default:
        days = 7;
        periodName = '7 дней';
    }

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // Получаем данные об активности за период
    const activeUsers = await ctx.db.User.find({
      lastActive: { $gte: startDate, $lte: endDate }
    });

    // Подготавливаем данные для почасового анализа
    let hourlyData = {};
    for (let hour = 0; hour < 24; hour++) {
      hourlyData[hour] = { count: 0, hours: [] };
    }

    let totalActivity = 0;
    let timeOfDayStats = {
      night: 0,    // 0-5 часов
      morning: 0,  // 6-11 часов
      afternoon: 0, // 12-17 часов
      evening: 0   // 18-23 часа
    };

    // Анализируем активность каждого пользователя
    activeUsers.forEach(user => {
      if (user.lastActive) {
        const lastActiveDate = new Date(user.lastActive);
        const hour = lastActiveDate.getHours();
        
        if (hourlyData[hour]) {
          hourlyData[hour].count++;
          hourlyData[hour].hours.push(lastActiveDate);
          totalActivity++;
          
          // Группируем по времени суток
          if (hour >= 0 && hour <= 5) timeOfDayStats.night++;
          else if (hour >= 6 && hour <= 11) timeOfDayStats.morning++;
          else if (hour >= 12 && hour <= 17) timeOfDayStats.afternoon++;
          else if (hour >= 18 && hour <= 23) timeOfDayStats.evening++;
        }
      }
    });

    // Преобразуем данные для графика
    let chartData = [];
    let maxHourlyCount = 0;
    let peakHour = 0;
    let peakHourCount = 0;
    
    for (let hour = 0; hour < 24; hour++) {
      const hourName = hour.toString().padStart(2, '0') + ':00';
      const count = hourlyData[hour]?.count || 0;
      
      chartData.push({
        hour: hourName,
        count: count,
        hourNum: hour
      });
      
      if (count > maxHourlyCount) {
        maxHourlyCount = count;
        peakHour = hour;
        peakHourCount = count;
      }
    }

    // Строим ASCII график
    let chart = '';
    const maxBarLength = 20;
    
    chartData.forEach(item => {
      const barLength = maxHourlyCount > 0 ? Math.round((item.count / maxHourlyCount) * maxBarLength) : 0;
      const bar = '█'.repeat(barLength) + '░'.repeat(maxBarLength - barLength);
      
      // Добавляем индикатор пикового часа
      const peakIndicator = item.hourNum === peakHour ? ' 🔥' : '';
      chart += `${item.hour}: ${bar} ${item.count}${peakIndicator}\n`;
    });

    // Формируем сообщение
    let message = `📱 <b>ПОЧАСОВАЯ АКТИВНОСТЬ (${periodName})</b>\n\n`;
    
    // Добавляем время обновления при refresh
    if (isRefresh) {
      const updateTime = new Date();
      const timeString = updateTime.toLocaleTimeString('ru-RU');
      message += `🕒 <b>Обновлено:</b> ${timeString}\n\n`;
    }
    
    message += `📅 Период анализа: ${startDate.toLocaleDateString('ru-RU')} - ${endDate.toLocaleDateString('ru-RU')}\n`;
    message += `👥 Активных пользователей: ${activeUsers.length}\n`;
    message += `📈 Всего действий: ${totalActivity}\n`;
    message += `📊 Средняя активность в час: ${(totalActivity / 24).toFixed(1)}\n\n`;
    
    message += `<pre>${chart}</pre>\n`;
    message += `📈 <b>Расшифровка графика:</b>\n`;
    message += `• █ - активность в час\n`;
    message += `• 🔥 - пиковый час\n\n`;
    
    message += `📊 <b>Ключевая статистика:</b>\n`;
    
    // Пиковый час
    const peakHourFormatted = peakHour.toString().padStart(2, '0') + ':00';
    const peakPercentage = totalActivity > 0 ? ((peakHourCount / totalActivity) * 100).toFixed(1) : 0;
    message += `• Пиковый час: ${peakHourFormatted} (${peakHourCount} действий, ${peakPercentage}%)\n`;
    
    // Часы с минимальной активностью
    let minHourCount = Infinity;
    let minHour = 0;
    chartData.forEach(item => {
      if (item.count < minHourCount && item.count > 0) {
        minHourCount = item.count;
        minHour = item.hourNum;
      }
    });
    
    if (minHourCount < Infinity) {
      const minHourFormatted = minHour.toString().padStart(2, '0') + ':00';
      message += `• Тихий час: ${minHourFormatted} (${minHourCount} действий)\n`;
    }
    
    // Часы без активности
    const hoursWithoutActivity = chartData.filter(item => item.count === 0).length;
    message += `• Часов без активности: ${hoursWithoutActivity}\n`;
    
    // Активность по времени суток
    if (totalActivity > 0) {
      message += `\n🌅 <b>Распределение по времени суток:</b>\n`;
      message += `• Ночь (00:00-05:59): ${timeOfDayStats.night} (${((timeOfDayStats.night / totalActivity) * 100).toFixed(1)}%)\n`;
      message += `• Утро (06:00-11:59): ${timeOfDayStats.morning} (${((timeOfDayStats.morning / totalActivity) * 100).toFixed(1)}%)\n`;
      message += `• День (12:00-17:59): ${timeOfDayStats.afternoon} (${((timeOfDayStats.afternoon / totalActivity) * 100).toFixed(1)}%)\n`;
      message += `• Вечер (18:00-23:59): ${timeOfDayStats.evening} (${((timeOfDayStats.evening / totalActivity) * 100).toFixed(1)}%)\n\n`;
    }
    
    // Рекомендации на основе анализа
    message += `💡 <b>Рекомендации:</b>\n`;
    
    if (peakHour >= 18 && peakHour <= 23) {
      message += `• Основная активность вечером - планируйте вечерние рассылки\n`;
    } else if (peakHour >= 12 && peakHour <= 17) {
      message += `• Пик активности днем - хорошее время для дневных уведомлений\n`;
    } else if (peakHour >= 6 && peakHour <= 11) {
      message += `• Пользователи активны утром - утренние напоминания будут эффективны\n`;
    }
    
    if (timeOfDayStats.evening > timeOfDayStats.morning * 1.5) {
      message += `• Вечерняя активность значительно выше - сосредоточьтесь на вечерних коммуникациях\n`;
    }
    
    if (hoursWithoutActivity >= 6) {
      message += `• Есть продолжительные периоды без активности - проверьте доступность бота\n`;
    }

    // Создаем клавиатуру с выбором периода
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(period === '7days' ? '✅ 7 дней' : '7 дней', 'chart_hourly_7days'),
        Markup.button.callback(period === '30days' ? '✅ 30 дней' : '30 дней', 'chart_hourly_30days'),
        Markup.button.callback(period === '90days' ? '✅ 90 дней' : '90 дней', 'chart_hourly_90days')
      ],
      [
        Markup.button.callback('🔄 Обновить', `chart_hourly_refresh_${period}`),
        Markup.button.callback('🎨 Тату по дням', 'chart_tattoo_dates')
      ],
      [
        Markup.button.callback('📊 Другие графики', 'admin_charts'),
        Markup.button.callback('🔙 Назад к аналитике', 'admin_analytics')
      ]
    ]);

    if (ctx.updateType === 'callback_query') {
      try {
        await ctx.editMessageText(message, {
          parse_mode: 'HTML',
          ...keyboard
        });
        await ctx.answerCbQuery();
        return true;
      } catch (editError) {
        // Если ошибка "message not modified", просто игнорируем
        if (editError.response && editError.response.description && 
            editError.response.description.includes('message is not modified')) {
          console.log('ℹ️ Сообщение не изменилось, пропускаем ошибку');
          await ctx.answerCbQuery();
          return true;
        }
        throw editError;
      }
    } else {
      await ctx.replyWithHTML(message, keyboard);
      return true;
    }

  } catch (error) {
    console.error('Ошибка при построении графика почасовой активности:', error);
    addToSystemLog(`Ошибка при построении графика почасовой активности: ${error.message}`, 'ERROR');
    
    const errorMessage = `❌ <b>Ошибка при построении графика почасовой активности</b>\n\n` +
      `Не удалось получить данные: ${error.message}`;
    
    if (ctx.updateType === 'callback_query') {
      try {
        await ctx.editMessageText(errorMessage, {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Повторить', 'chart_hourly_activity')],
            [Markup.button.callback('🔙 Назад', 'admin_charts')]
          ])
        });
        await ctx.answerCbQuery('❌ Ошибка');
      } catch (editError) {
        await ctx.answerCbQuery('❌ Ошибка загрузки');
      }
    } else {
      await ctx.reply(errorMessage);
    }
    return false;
  }
}


// Функция для отображения всех вопросов
async function showAllQuestionsList(ctx, page = 1, isRefresh = false) {
  try {
    const ADMIN_ID = 1427347068;
    
    // Проверка прав администратора
    if (ctx.from.id !== ADMIN_ID) {
      const errorMsg = '❌ У вас нет прав администратора';
      if (ctx.updateType === 'callback_query') {
        await ctx.answerCbQuery(errorMsg);
        await ctx.editMessageText(errorMsg);
      } else {
        await ctx.reply(errorMsg);
      }
      return false;
    }
    
    // Проверка подключения к БД
    if (!ctx.db || !ctx.db.User) {
      const errorMsg = '❌ База данных не доступна';
      if (ctx.updateType === 'callback_query') {
        await ctx.answerCbQuery(errorMsg);
        await ctx.editMessageText(errorMsg);
      } else {
        await ctx.reply(errorMsg);
      }
      return false;
    }
    
    const limit = 10;
    const skip = (page - 1) * limit;
    
    // Получаем всех пользователей с вопросами
    const users = await ctx.db.User.find({ 'questions.0': { $exists: true } });
    
    // Собираем все вопросы в один массив
    let allQuestions = [];
    
    users.forEach(user => {
      if (user.questions && Array.isArray(user.questions)) {
        user.questions.forEach(q => {
          allQuestions.push({
            userId: user.telegramId,
            userName: user.firstName || 'Аноним',
            question: q.question,
            date: q.date,
            status: q.status || 'pending',
            answer: q.answer,
            answeredAt: q.answeredAt,
            questionId: q._id
          });
        });
      }
    });
    
    // Сортируем по дате (новые сверху)
    allQuestions.sort((a, b) => {
      const dateA = a.date ? new Date(a.date) : new Date(0);
      const dateB = b.date ? new Date(b.date) : new Date(0);
      return dateB - dateA;
    });
    
    const totalQuestions = allQuestions.length;
    const totalPages = Math.ceil(totalQuestions / limit);
    
    // Пагинация
    const questions = allQuestions.slice(skip, skip + limit);
    
    if (totalQuestions === 0) {
      const message = '❓ <b>ВСЕ ВОПРОСЫ ПОЛЬЗОВАТЕЛЕЙ</b>\n\n' +
                     '📭 Нет вопросов от пользователей.';
      
      if (ctx.updateType === 'callback_query') {
        await ctx.editMessageText(message, {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Обновить', 'admin_all_questions')],
            [Markup.button.callback('❓ Ожидающие', 'admin_questions')],
            [Markup.button.callback('🔙 Назад', 'admin_back')]
          ])
        });
        await ctx.answerCbQuery();
      } else {
        await ctx.replyWithHTML(message, Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Обновить', 'admin_all_questions')],
          [Markup.button.callback('❓ Ожидающие', 'admin_questions')],
          [Markup.button.callback('🔙 Назад', 'admin_back')]
        ]));
      }
      return true;
    }
    
    let message = `❓ <b>ВСЕ ВОПРОСЫ</b> (страница ${page}/${totalPages})\n\n`;
    
    questions.forEach((q, index) => {
      const number = skip + index + 1;
      const date = q.date ? new Date(q.date).toLocaleString('ru-RU') : 'н/д';
      const status = q.status === 'answered' ? '✅ Отвечен' : 
                    q.status === 'pending' ? '⏳ Ожидает ответа' : 
                    `❓ ${q.status || 'Неизвестно'}`;
      
      message += `<b>${number}. ${q.userName}</b> (ID: ${q.userId})\n`;
      message += `📅 ${date}\n`;
      message += `📊 Статус: ${status}\n`;
      
      // Вопрос
      const questionText = q.question.length > 80 ? 
        q.question.substring(0, 80) + '...' : q.question;
      message += `💬 Вопрос: ${questionText}\n`;
      
      // Ответ (если есть)
      if (q.answer) {
        const answerText = q.answer.length > 60 ? 
          q.answer.substring(0, 60) + '...' : q.answer;
        message += `📝 Ответ: ${answerText}\n`;
      }
      
      message += `────────────────────\n`;
    });
    
    message += `\n📊 <b>Всего вопросов:</b> ${totalQuestions}`;
    
    // Статистика по статусам
    const answeredCount = allQuestions.filter(q => q.status === 'answered').length;
    const pendingCount = allQuestions.filter(q => q.status === 'pending').length;
    message += `\n📈 <b>Отвечено:</b> ${answeredCount} | <b>Ожидают:</b> ${pendingCount}`;
    
    // Добавляем время обновления только при refresh
    if (isRefresh) {
      const updateTime = new Date();
      const timeString = updateTime.toLocaleTimeString('ru-RU');
      message += `\n🕒 <b>Обновлено:</b> ${timeString}`;
    }
    
    // Создаем клавиатуру с пагинацией
    const keyboardButtons = [];
    
    // Кнопки навигации
    const navRow = [];
    if (page > 1) {
      navRow.push(Markup.button.callback('⬅️ Назад', `admin_all_questions_page_${page - 1}`));
    }
    
    if (page < totalPages) {
      navRow.push(Markup.button.callback('Вперед ➡️', `admin_all_questions_page_${page + 1}`));
    }
    
    if (navRow.length > 0) {
      keyboardButtons.push(navRow);
    }
    
    // Кнопки действий
    keyboardButtons.push([
      Markup.button.callback('🔄 Обновить', `admin_all_questions_refresh_${page}`),
      Markup.button.callback('❓ Ожидающие', 'admin_questions')
    ]);
    
    keyboardButtons.push([
      Markup.button.callback('📊 Статистика', 'admin_stats'),
      Markup.button.callback('🔙 Назад', 'admin_back')
    ]);
    
    const keyboard = Markup.inlineKeyboard(keyboardButtons);
    
    if (ctx.updateType === 'callback_query') {
      try {
        await ctx.editMessageText(message, {
          parse_mode: 'HTML',
          ...keyboard
        });
        await ctx.answerCbQuery();
        return true;
      } catch (editError) {
        // Если ошибка "message not modified", просто игнорируем
        if (editError.response && editError.response.description && 
            editError.response.description.includes('message is not modified')) {
          console.log('ℹ️ Сообщение не изменилось, пропускаем ошибку');
          await ctx.answerCbQuery();
          return true;
        }
        throw editError;
      }
    } else {
      await ctx.replyWithHTML(message, keyboard);
      return true;
    }
    
  } catch (error) {
    console.error('Ошибка при отображении вопросов:', error);
    
    const errorMessage = `❌ Ошибка при загрузке вопросов:\n${error.message}`;
    
    if (ctx.updateType === 'callback_query') {
      try {
        await ctx.editMessageText(errorMessage, {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Попробовать снова', 'admin_all_questions')],
            [Markup.button.callback('🔙 Назад', 'admin_back')]
          ])
        });
        await ctx.answerCbQuery('❌ Ошибка');
      } catch (editError) {
        await ctx.answerCbQuery('❌ Ошибка загрузки');
      }
    } else {
      await ctx.reply(errorMessage);
    }
    return false;
  }
}

// Функция для отображения сводной аналитики (дашборд)
async function showSummaryChart(ctx, isRefresh = false) {
  try {
    const ADMIN_ID = 1427347068;
    if (ctx.from.id !== ADMIN_ID) return;

    addToSystemLog(`Админ ${ctx.from.id} запросил сводную аналитику`, 'ADMIN_ACTION');

    // Получаем все данные параллельно для производительности
    const [
      totalUsers,
      usersWithTattoo,
      usersWithQuestions,
      activeUsersToday,
      activeUsersWeek,
      usersToday,
      questionsTotal,
      questionsPending,
      questionsAnswered
    ] = await Promise.all([
      // 1. Общее количество пользователей
      ctx.db.User.countDocuments({}),
      
      // 2. Пользователи с датой тату
      ctx.db.User.countDocuments({ tattooDate: { $ne: null, $exists: true } }),
      
      // 3. Пользователи с вопросами
      ctx.db.User.countDocuments({ 'questions.0': { $exists: true } }),
      
      // 4. Активные сегодня
      (async () => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        return ctx.db.User.countDocuments({ lastActive: { $gte: today } });
      })(),
      
      // 5. Активные за неделю
      (async () => {
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);
        return ctx.db.User.countDocuments({ lastActive: { $gte: weekAgo } });
      })(),
      
      // 6. Новые пользователи сегодня
      (async () => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        return ctx.db.User.countDocuments({ createdAt: { $gte: today } });
      })(),
      
      // 7. Всего вопросов
      (async () => {
        const users = await ctx.db.User.find({ 'questions.0': { $exists: true } });
        return users.reduce((total, user) => total + (user.questions?.length || 0), 0);
      })(),
      
      // 8. Вопросы ожидающие ответа
      (async () => {
        const users = await ctx.db.User.find({ 'questions.0': { $exists: true } });
        return users.reduce((total, user) => {
          if (user.questions && Array.isArray(user.questions)) {
            return total + user.questions.filter(q => q.status === 'pending').length;
          }
          return total;
        }, 0);
      })(),
      
      // 9. Отвеченные вопросы
      (async () => {
        const users = await ctx.db.User.find({ 'questions.0': { $exists: true } });
        return users.reduce((total, user) => {
          if (user.questions && Array.isArray(user.questions)) {
            return total + user.questions.filter(q => q.status === 'answered').length;
          }
          return total;
        }, 0);
      })()
    ]);

    // Получаем данные для графиков трендов (за последние 7 дней)
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);

    // Регистрации по дням
    const registrationsByDay = await ctx.db.User.aggregate([
      {
        $match: {
          createdAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
            day: { $dayOfMonth: '$createdAt' }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }
    ]);

    // Активность по дням
    const activityByDay = await ctx.db.User.aggregate([
      {
        $match: {
          lastActive: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$lastActive' },
            month: { $month: '$lastActive' },
            day: { $dayOfMonth: '$lastActive' }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }
    ]);

    // Подготавливаем данные для мини-графиков
    let registrationsChart = '';
    let activityChart = '';
    
    // Мини-график регистраций
    const regData = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
      
      const dayData = registrationsByDay.find(item => 
        item._id.day === date.getDate() && 
        item._id.month === date.getMonth() + 1 &&
        item._id.year === date.getFullYear()
      );
      
      regData.push(dayData ? dayData.count : 0);
    }
    
    const maxReg = Math.max(...regData, 1);
    regData.forEach(count => {
      const barLength = Math.round((count / maxReg) * 10);
      registrationsChart += '█'.repeat(barLength) + '░'.repeat(10 - barLength) + '\n';
    });
    
    // Мини-график активности
    const actData = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
      
      const dayData = activityByDay.find(item => 
        item._id.day === date.getDate() && 
        item._id.month === date.getMonth() + 1 &&
        item._id.year === date.getFullYear()
      );
      
      actData.push(dayData ? dayData.count : 0);
    }
    
    const maxAct = Math.max(...actData, 1);
    actData.forEach(count => {
      const barLength = Math.round((count / maxAct) * 10);
      activityChart += '█'.repeat(barLength) + '░'.repeat(10 - barLength) + '\n';
    });

    // Расчет процентов
    const tattooPercentage = totalUsers > 0 ? ((usersWithTattoo / totalUsers) * 100).toFixed(1) : 0;
    const questionsPercentage = totalUsers > 0 ? ((usersWithQuestions / totalUsers) * 100).toFixed(1) : 0;
    const activeTodayPercentage = totalUsers > 0 ? ((activeUsersToday / totalUsers) * 100).toFixed(1) : 0;
    const activeWeekPercentage = totalUsers > 0 ? ((activeUsersWeek / totalUsers) * 100).toFixed(1) : 0;
    const answerRate = questionsTotal > 0 ? ((questionsAnswered / questionsTotal) * 100).toFixed(1) : 0;

    // Определяем тренды (простая логика)
    const getTrend = (current, previous) => {
      if (current > previous * 1.2) return '📈';
      if (current < previous * 0.8) return '📉';
      return '➡️';
    };

    // Формируем сообщение
    let message = `📊 <b>СВОДНАЯ АНАЛИТИКА (ДАШБОРД)</b>\n\n`;
    
    // Добавляем время обновления
    const updateTime = new Date();
    const timeString = updateTime.toLocaleTimeString('ru-RU');
    const dateString = updateTime.toLocaleDateString('ru-RU');
    message += `🕒 <b>Обновлено:</b> ${dateString} ${timeString}\n\n`;
    
    message += `👥 <b>ОСНОВНЫЕ МЕТРИКИ</b>\n`;
    message += `├ Всего пользователей: ${totalUsers}\n`;
    message += `├ Новых сегодня: ${usersToday}\n`;
    message += `├ С датой тату: ${usersWithTattoo} (${tattooPercentage}%)\n`;
    message += `├ С вопросами: ${usersWithQuestions} (${questionsPercentage}%)\n`;
    message += `├ Активных сегодня: ${activeUsersToday} (${activeTodayPercentage}%)\n`;
    message += `└ Активных за неделю: ${activeUsersWeek} (${activeWeekPercentage}%)\n\n`;
    
    message += `❓ <b>ВОПРОСЫ ПОЛЬЗОВАТЕЛЕЙ</b>\n`;
    message += `├ Всего вопросов: ${questionsTotal}\n`;
    message += `├ Ожидают ответа: ${questionsPending}\n`;
    message += `├ Отвечено: ${questionsAnswered}\n`;
    message += `└ Процент ответов: ${answerRate}%\n\n`;
    
    message += `📈 <b>ТРЕНДЫ ЗА 7 ДНЕЙ</b>\n`;
    message += `┌─────────────────┬─────────────────┐\n`;
    message += `│   Регистрации   │   Активность   │\n`;
    message += `├─────────────────┼─────────────────┤\n`;
    
    // Объединяем графики построчно
    const regLines = registrationsChart.trim().split('\n');
    const actLines = activityChart.trim().split('\n');
    
    for (let i = 0; i < regLines.length; i++) {
      const regLine = regLines[i] || '';
      const actLine = actLines[i] || '';
      message += `│ ${regLine.padEnd(15)} │ ${actLine.padEnd(15)} │\n`;
    }
    
    message += `└─────────────────┴─────────────────┘\n\n`;
    
    message += `📅 <b>ДАТЫ ГРАФИКОВ:</b>\n`;
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
      message += `${dateStr} `;
    }
    message += `\n\n`;
    
    message += `🚀 <b>БЫСТРЫЕ ДЕЙСТВИЯ:</b>`;
    
    // Создаем клавиатуру с основными метриками и действиями
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('👥 ' + totalUsers, 'admin_users'),
        Markup.button.callback('❓ ' + questionsTotal, 'admin_all_questions'),
        Markup.button.callback('🎨 ' + usersWithTattoo, 'chart_tattoo_dates')
      ],
      [
        Markup.button.callback('📈 Рост', 'chart_users_growth'),
        Markup.button.callback('📅 Активность', 'chart_daily_activity'),
        Markup.button.callback('📱 По часам', 'chart_hourly_activity')
      ],
      [
        Markup.button.callback('🔄 Обновить', 'chart_summary_refresh'),
        Markup.button.callback('📊 Все графики', 'admin_charts')
      ],
      [
        Markup.button.callback('📢 Рассылка', 'admin_broadcast'),
        Markup.button.callback('🔙 Назад к аналитике', 'admin_analytics')
      ]
    ]);

    if (ctx.updateType === 'callback_query') {
      try {
        await ctx.editMessageText(message, {
          parse_mode: 'HTML',
          ...keyboard
        });
        await ctx.answerCbQuery();
        return true;
      } catch (editError) {
        // Если ошибка "message not modified", просто игнорируем
        if (editError.response && editError.response.description && 
            editError.response.description.includes('message is not modified')) {
          console.log('ℹ️ Сообщение не изменилось, пропускаем ошибку');
          await ctx.answerCbQuery();
          return true;
        }
        throw editError;
      }
    } else {
      await ctx.replyWithHTML(message, keyboard);
      return true;
    }

  } catch (error) {
    console.error('Ошибка при построении сводной аналитики:', error);
    addToSystemLog(`Ошибка при построении сводной аналитики: ${error.message}`, 'ERROR');
    
    const errorMessage = `❌ <b>Ошибка при построении сводной аналитики</b>\n\n` +
      `Не удалось получить данные: ${error.message}`;
    
    if (ctx.updateType === 'callback_query') {
      try {
        await ctx.editMessageText(errorMessage, {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Повторить', 'chart_summary')],
            [Markup.button.callback('🔙 Назад', 'admin_charts')]
          ])
        });
        await ctx.answerCbQuery('❌ Ошибка');
      } catch (editError) {
        await ctx.answerCbQuery('❌ Ошибка загрузки');
      }
    } else {
      await ctx.reply(errorMessage);
    }
    return false;
  }
}


async function startBroadcastToActiveUsers(ctx, messageText) {
  try {
    const ADMIN_ID = 1427347068;
    if (ctx.from.id !== ADMIN_ID) {
      return false;
    }

    console.log(`📅 Админ ${ctx.from.id} начинает рассылку активным пользователям (7 дней)`);

    // Сбрасываем состояние
    broadcastState.isActive = true;
    broadcastState.currentAdminId = ctx.from.id;
    broadcastState.messageText = messageText;
    broadcastState.totalUsers = 0;
    broadcastState.successCount = 0;
    broadcastState.failedCount = 0;
    broadcastState.startTime = new Date();

    // Получаем активных пользователей (за последние 7 дней)
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    
    const users = await ctx.db.User.find({ 
      lastActive: { $gte: weekAgo }
    });
    broadcastState.totalUsers = users.length;

    // Получаем статистику
    const totalUsers = await ctx.db.User.countDocuments({});
    const activeUsersPercentage = totalUsers > 0 ? Math.round((users.length / totalUsers) * 100) : 0;

    // Если активных пользователей нет
    if (users.length === 0) {
      broadcastState.isActive = false;
      await ctx.reply('❌ <b>Нет активных пользователей</b>\n\n' +
        'В базе данных нет пользователей, активных за последние 7 дней.\n\n' +
        '📊 <b>Статистика:</b>\n' +
        `• Всего пользователей: ${totalUsers}\n` +
        `• Активных (7 дней): ${users.length} (${activeUsersPercentage}%)\n\n` +
        '💡 <b>Совет:</b> Попробуйте рассылку всем пользователям.',
        { parse_mode: 'HTML' });
      return false;
    }

    // Отправляем сообщение о начале рассылки
    const startMessage = await ctx.replyWithHTML(
      `📅 <b>РАССЫЛКА АКТИВНЫМ ПОЛЬЗОВАТЕЛЯМ (7 ДНЕЙ)</b>\n\n` +
      `📝 <b>Сообщение:</b>\n${messageText.substring(0, 200)}${messageText.length > 200 ? '...' : ''}\n\n` +
      `📊 <b>Целевая аудитория:</b>\n` +
      `• Всего пользователей: ${totalUsers}\n` +
      `• Активных (7 дней): ${users.length} (${activeUsersPercentage}%)\n\n` +
      `⏱️ <b>Начало:</b> ${broadcastState.startTime.toLocaleTimeString('ru-RU')}\n\n` +
      `🔄 <b>Рассылка началась...</b>`
    );

    let progressMessageId = startMessage.message_id;

    // Функция обновления прогресса
    const updateProgress = async () => {
      if (!broadcastState.isActive) return;

      const progress = Math.round((broadcastState.successCount + broadcastState.failedCount) / broadcastState.totalUsers * 100);
      const elapsed = Math.floor((new Date() - broadcastState.startTime) / 1000);
      const remaining = users.length - (broadcastState.successCount + broadcastState.failedCount);

      try {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          progressMessageId,
          null,
          `📅 <b>РАССЫЛКА АКТИВНЫМ ПОЛЬЗОВАТЕЛЯМ</b>\n\n` +
          `📝 <b>Сообщение:</b>\n${broadcastState.messageText.substring(0, 120)}${broadcastState.messageText.length > 120 ? '...' : ''}\n\n` +
          `📊 <b>Прогресс:</b> ${progress}%\n` +
          `✅ <b>Успешно:</b> ${broadcastState.successCount}\n` +
          `❌ <b>Не удалось:</b> ${broadcastState.failedCount}\n` +
          `📅 <b>Активных:</b> ${users.length}\n` +
          `⏱️ <b>Прошло времени:</b> ${elapsed} сек\n` +
          `📋 <b>Осталось:</b> ${remaining}\n\n` +
          `🔄 <b>Рассылка продолжается...</b>`,
          { parse_mode: 'HTML' }
        );
      } catch (error) {
        console.error('Ошибка при обновлении прогресса:', error);
      }
    };

    // Отправляем сообщения пользователям
    for (let i = 0; i < users.length; i++) {
      if (!broadcastState.isActive) break;

      const user = users[i];
      
      try {
        // Пропускаем администратора
        if (user.telegramId === ADMIN_ID) {
          broadcastState.successCount++;
          continue;
        }

        await ctx.telegram.sendMessage(
          user.telegramId,
          `📅 <b>СООБЩЕНИЕ ДЛЯ АКТИВНЫХ ПОЛЬЗОВАТЕЛЕЙ</b>\n\n${messageText}\n\n— Администрация бота`,
          { parse_mode: 'HTML' }
        );
        
        broadcastState.successCount++;
        
        // Обновляем прогресс каждые 5 отправок
        if (i % 5 === 0 || i === users.length - 1) {
          await updateProgress();
        }
        
        // Задержка между сообщениями
        await new Promise(resolve => setTimeout(resolve, 150));
        
      } catch (error) {
        console.error(`Ошибка отправки пользователю ${user.telegramId}:`, error.message);
        broadcastState.failedCount++;
        
        // Если пользователь заблокировал бота, удаляем его из БД
        if (error.response && error.response.error_code === 403) {
          try {
            await ctx.db.User.deleteOne({ telegramId: user.telegramId });
            console.log(`Пользователь ${user.telegramId} заблокировал бота, удален из БД`);
          } catch (deleteError) {
            console.error('Ошибка при удалении пользователя:', deleteError);
          }
        }
      }
    }

    // Завершение рассылки
    broadcastState.endTime = new Date();
    broadcastState.isActive = false;
    
    const totalTime = Math.floor((broadcastState.endTime - broadcastState.startTime) / 1000);
    const successRate = Math.round((broadcastState.successCount / broadcastState.totalUsers) * 100);

    // Финальное сообщение
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      progressMessageId,
      null,
      `✅ <b>РАССЫЛКА АКТИВНЫМ ПОЛЬЗОВАТЕЛЯМ ЗАВЕРШЕНА</b>\n\n` +
      `📊 <b>Результаты:</b>\n` +
      `• Всего получателей: ${users.length}\n` +
      `• Успешно отправлено: ${broadcastState.successCount}\n` +
      `• Не удалось отправить: ${broadcastState.failedCount}\n` +
      `• Процент успеха: ${successRate}%\n\n` +
      `⏱️ <b>Время:</b>\n` +
      `• Начало: ${broadcastState.startTime.toLocaleTimeString('ru-RU')}\n` +
      `• Завершение: ${broadcastState.endTime.toLocaleTimeString('ru-RU')}\n` +
      `• Общее время: ${totalTime} секунд\n\n` +
      `📈 <b>Аналитика:</b>\n` +
      `Это сегмент пользователей, которые недавно использовали бот и, скорее всего, увидят сообщение.`,
      { parse_mode: 'HTML' }
    );

    addToSystemLog(`Рассылка активным пользователям завершена. Успешно: ${broadcastState.successCount}/${users.length}`, 'ADMIN_ACTION');
    return true;

  } catch (error) {
    console.error('❌ Ошибка при рассылке активным пользователям:', error);
    addToSystemLog(`Ошибка при рассылке активным пользователям: ${error.message}`, 'ERROR');
    
    broadcastState.isActive = false;
    
    await ctx.reply(
      `❌ <b>ОШИБКА ПРИ РАССЫЛКЕ АКТИВНЫМ ПОЛЬЗОВАТЕЛЯМ</b>\n\n` +
      `Произошла ошибка: ${error.message}\n\n` +
      `Частично отправлено: ${broadcastState.successCount} сообщений.`,
      { parse_mode: 'HTML' }
    );
    
    return false;
  }
}


// Функция для запуска рассылки всем пользователям
async function startBroadcastToAll(ctx, messageText) {
  try {
    const ADMIN_ID = 1427347068;
    if (ctx.from.id !== ADMIN_ID) {
      return false;
    }

    addToSystemLog(`Админ ${ctx.from.id} начинает рассылку всем пользователям`, 'ADMIN_ACTION');

    // Сбрасываем состояние
    broadcastState.isActive = true;
    broadcastState.currentAdminId = ctx.from.id;
    broadcastState.messageText = messageText;
    broadcastState.totalUsers = 0;
    broadcastState.successCount = 0;
    broadcastState.failedCount = 0;
    broadcastState.startTime = new Date();

    // Получаем всех пользователей
    const users = await ctx.db.User.find({});
    broadcastState.totalUsers = users.length;

    // Если пользователей нет
    if (users.length === 0) {
      broadcastState.isActive = false;
      await ctx.reply('❌ <b>Нет пользователей для рассылки</b>\n\nВ базе данных нет зарегистрированных пользователей.', {
        parse_mode: 'HTML'
      });
      return false;
    }

    // Отправляем сообщение о начале рассылки
    const startMessage = await ctx.replyWithHTML(
      `📢 <b>НАЧАЛО РАССЫЛКИ</b>\n\n` +
      `📝 <b>Сообщение:</b>\n${messageText.substring(0, 200)}${messageText.length > 200 ? '...' : ''}\n\n` +
      `👥 <b>Получателей:</b> ${users.length}\n` +
      `⏱️ <b>Начало:</b> ${broadcastState.startTime.toLocaleTimeString('ru-RU')}\n\n` +
      `🔄 <b>Рассылка началась...</b>`
    );

    let progressMessageId = startMessage.message_id;

    // Функция обновления прогресса
    const updateProgress = async () => {
      if (!broadcastState.isActive) return;

      const progress = Math.round((broadcastState.successCount + broadcastState.failedCount) / broadcastState.totalUsers * 100);
      const elapsed = Math.floor((new Date() - broadcastState.startTime) / 1000);

      try {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          progressMessageId,
          null,
          `📢 <b>РАССЫЛКА В ПРОЦЕССЕ</b>\n\n` +
          `📝 <b>Сообщение:</b>\n${broadcastState.messageText.substring(0, 150)}${broadcastState.messageText.length > 150 ? '...' : ''}\n\n` +
          `📊 <b>Прогресс:</b> ${progress}%\n` +
          `✅ <b>Успешно:</b> ${broadcastState.successCount}\n` +
          `❌ <b>Не удалось:</b> ${broadcastState.failedCount}\n` +
          `👥 <b>Всего:</b> ${broadcastState.totalUsers}\n` +
          `⏱️ <b>Прошло времени:</b> ${elapsed} сек\n\n` +
          `🔄 <b>Рассылка продолжается...</b>`,
          { parse_mode: 'HTML' }
        );
      } catch (error) {
        console.error('Ошибка при обновлении прогресса:', error);
      }
    };

    // Отправляем сообщения пользователям
    for (let i = 0; i < users.length; i++) {
      if (!broadcastState.isActive) break;

      const user = users[i];
      
      try {
        // Пропускаем администратора, если это не нужно
        if (user.telegramId === ADMIN_ID) {
          broadcastState.successCount++;
          continue;
        }

        await ctx.telegram.sendMessage(
          user.telegramId,
          `📢 <b>ВАЖНОЕ ОБЪЯВЛЕНИЕ</b>\n\n${messageText}\n\n— Администрация бота`,
          { parse_mode: 'HTML' }
        );
        
        broadcastState.successCount++;
        
        // Обновляем прогресс каждые 10 отправок или каждые 5 секунд
        if (i % 10 === 0 || i === users.length - 1) {
          await updateProgress();
        }
        
        // Задержка между сообщениями, чтобы не спамить
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        console.error(`Ошибка отправки пользователю ${user.telegramId}:`, error.message);
        broadcastState.failedCount++;
        
        // Если пользователь заблокировал бота, удаляем его из БД
        if (error.response && error.response.error_code === 403) {
          try {
            await ctx.db.User.deleteOne({ telegramId: user.telegramId });
            addToSystemLog(`Пользователь ${user.telegramId} заблокировал бота, удален из БД`, 'INFO');
          } catch (deleteError) {
            console.error('Ошибка при удалении пользователя:', deleteError);
          }
        }
      }
    }

    // Завершение рассылки
    broadcastState.endTime = new Date();
    broadcastState.isActive = false;
    
    const totalTime = Math.floor((broadcastState.endTime - broadcastState.startTime) / 1000);
    const successRate = Math.round((broadcastState.successCount / broadcastState.totalUsers) * 100);

    // Финальное сообщение
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      progressMessageId,
      null,
      `✅ <b>РАССЫЛКА ЗАВЕРШЕНА</b>\n\n` +
      `📊 <b>Результаты:</b>\n` +
      `• Всего получателей: ${broadcastState.totalUsers}\n` +
      `• Успешно отправлено: ${broadcastState.successCount}\n` +
      `• Не удалось отправить: ${broadcastState.failedCount}\n` +
      `• Процент успеха: ${successRate}%\n\n` +
      `⏱️ <b>Время:</b>\n` +
      `• Начало: ${broadcastState.startTime.toLocaleTimeString('ru-RU')}\n` +
      `• Завершение: ${broadcastState.endTime.toLocaleTimeString('ru-RU')}\n` +
      `• Общее время: ${totalTime} секунд\n\n` +
      `💡 <b>Примечание:</b>\n` +
      `Пользователи, заблокировавшие бота, автоматически удалены из базы данных.`,
      { parse_mode: 'HTML' }
    );

    addToSystemLog(`Рассылка завершена. Успешно: ${broadcastState.successCount}, Не удалось: ${broadcastState.failedCount}`, 'ADMIN_ACTION');
    return true;

  } catch (error) {
    console.error('❌ Критическая ошибка при рассылке:', error);
    addToSystemLog(`Ошибка при рассылке: ${error.message}`, 'ERROR');
    
    broadcastState.isActive = false;
    
    await ctx.reply(
      `❌ <b>ОШИБКА ПРИ РАССЫЛКЕ</b>\n\n` +
      `Произошла критическая ошибка: ${error.message}\n\n` +
      `Рассылка прервана. Частично отправлено: ${broadcastState.successCount} сообщений.`,
      { parse_mode: 'HTML' }
    );
    
    return false;
  }
}

// Функция для отображения детального отчета
async function showDetailedReport(ctx, reportType = 'summary', isRefresh = false) {
  try {
    const ADMIN_ID = 1427347068;
    if (ctx.from.id !== ADMIN_ID) return;

    addToSystemLog(`Админ ${ctx.from.id} запросил детальный отчет (тип: ${reportType})`, 'ADMIN_ACTION');

    let message = '';
    let keyboard = null;

    switch (reportType) {
      case 'summary':
        // Получаем основные данные для сводки
        const [totalUsers, usersWithTattoo, usersWithQuestions, activeUsersWeek] = await Promise.all([
          ctx.db.User.countDocuments({}),
          ctx.db.User.countDocuments({ tattooDate: { $ne: null, $exists: true } }),
          ctx.db.User.countDocuments({ 'questions.0': { $exists: true } }),
          (async () => {
            const weekAgo = new Date();
            weekAgo.setDate(weekAgo.getDate() - 7);
            return ctx.db.User.countDocuments({ lastActive: { $gte: weekAgo } });
          })()
        ]);

        message = `📋 <b>ДЕТАЛЬНЫЙ ОТЧЕТ - СВОДКА</b>\n\n`;
        
        if (isRefresh) {
          const updateTime = new Date();
          message += `🕒 <b>Обновлено:</b> ${updateTime.toLocaleTimeString('ru-RU')}\n\n`;
        }

        message += `📊 <b>ОСНОВНЫЕ ПОКАЗАТЕЛИ</b>\n`;
        message += `┌─────────────────────────────┐\n`;
        message += `│ Метрика             │ Значение │\n`;
        message += `├─────────────────────────────┤\n`;
        message += `│ 👥 Всего пользователей │ ${totalUsers.toString().padEnd(8)} │\n`;
        message += `│ 🎨 С датой тату       │ ${usersWithTattoo.toString().padEnd(8)} │\n`;
        message += `│ ❓ С вопросами        │ ${usersWithQuestions.toString().padEnd(8)} │\n`;
        message += `│ 📅 Активных (7 дней)  │ ${activeUsersWeek.toString().padEnd(8)} │\n`;
        message += `└─────────────────────────────┘\n\n`;

        message += `📈 <b>ПРОЦЕНТНЫЕ СООТНОШЕНИЯ</b>\n`;
        if (totalUsers > 0) {
          const tattooPercent = ((usersWithTattoo / totalUsers) * 100).toFixed(1);
          const questionsPercent = ((usersWithQuestions / totalUsers) * 100).toFixed(1);
          const activePercent = ((activeUsersWeek / totalUsers) * 100).toFixed(1);
          
          message += `• С датой тату: ${tattooPercent}%\n`;
          message += `• С вопросами: ${questionsPercent}%\n`;
          message += `• Активных: ${activePercent}%\n\n`;
        }

        message += `💡 <b>РЕКОМЕНДАЦИИ</b>\n`;
        if (usersWithTattoo < totalUsers * 0.5) {
          message += `• Мало пользователей указали дату тату. Рекомендуется напоминать через /setdate\n`;
        }
        if (activeUsersWeek < totalUsers * 0.3) {
          message += `• Низкая активность пользователей. Рассмотрите рассылку для вовлечения\n`;
        }

        keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback('👥 Подробно о пользователях', 'report_users'),
            Markup.button.callback('❓ Статистика вопросов', 'report_questions')
          ],
          [
            Markup.button.callback('🎨 Анализ татуировок', 'report_tattoos'),
            Markup.button.callback('📊 Полный отчет', 'report_full')
          ],
          [
            Markup.button.callback('🔄 Обновить', 'report_refresh_summary'),
            Markup.button.callback('🔙 Назад к аналитике', 'admin_analytics')
          ]
        ]);
        break;

      case 'users':
        // Детальный отчет по пользователям
        const users = await ctx.db.User.find({}).sort({ createdAt: -1 }).limit(50);
        const newUsersToday = await ctx.db.User.countDocuments({
          createdAt: { 
            $gte: new Date(new Date().setHours(0, 0, 0, 0)) 
          }
        });

        message = `👥 <b>ДЕТАЛЬНЫЙ ОТЧЕТ - ПОЛЬЗОВАТЕЛИ</b>\n\n`;
        
        message += `📊 <b>ОБЩАЯ СТАТИСТИКА</b>\n`;
        message += `• Всего пользователей: ${users.length}\n`;
        message += `• Новых сегодня: ${newUsersToday}\n`;
        message += `• Последние 7 дней: ${await ctx.db.User.countDocuments({
          createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
        })}\n\n`;

        message += `👑 <b>ПОСЛЕДНИЕ ПОЛЬЗОВАТЕЛИ (первые 10)</b>\n`;
        users.slice(0, 10).forEach((user, index) => {
          const date = user.createdAt ? user.createdAt.toLocaleDateString('ru-RU') : 'н/д';
          const hasTattoo = user.tattooDate ? '✅' : '❌';
          const questionsCount = user.questions?.length || 0;
          message += `${index + 1}. ${user.firstName || 'Аноним'} (ID: ${user.telegramId})\n`;
          message += `   📅 ${date} | 🎨 ${hasTattoo} | ❓ ${questionsCount}\n`;
        });

        if (users.length > 10) {
          message += `\n📋 ... и еще ${users.length - 10} пользователей\n`;
        }

        keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback('📈 Топ по активности', 'report_active_users'),
            Markup.button.callback('❓ Топ по вопросам', 'report_top_questions')
          ],
          [
            Markup.button.callback('🔄 Обновить', 'report_refresh_users'),
            Markup.button.callback('📊 Сводка', 'report_summary')
          ],
          [
            Markup.button.callback('🔙 Назад к аналитике', 'admin_analytics')
          ]
        ]);
        break;

      case 'questions':
        // Детальный отчет по вопросам
        const allUsers = await ctx.db.User.find({ 'questions.0': { $exists: true } });
        
        let allQuestions = [];
        let totalQuestions = 0;
        let pendingQuestions = 0;
        let answeredQuestions = 0;
        
        allUsers.forEach(user => {
          if (user.questions && Array.isArray(user.questions)) {
            const userQuestions = user.questions.map(q => ({
              ...q,
              userId: user.telegramId,
              userName: user.firstName || `ID:${user.telegramId}`
            }));
            allQuestions = allQuestions.concat(userQuestions);
            totalQuestions += user.questions.length;
            pendingQuestions += user.questions.filter(q => q.status === 'pending').length;
            answeredQuestions += user.questions.filter(q => q.status === 'answered').length;
          }
        });

        // Сортируем вопросы по дате (новые сверху)
        allQuestions.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

        message = `❓ <b>ДЕТАЛЬНЫЙ ОТЧЕТ - ВОПРОСЫ</b>\n\n`;
        
        message += `📊 <b>СТАТИСТИКА ВОПРОСОВ</b>\n`;
        message += `• Всего вопросов: ${totalQuestions}\n`;
        message += `• Ожидают ответа: ${pendingQuestions}\n`;
        message += `• Отвечено: ${answeredQuestions}\n`;
        message += `• Процент ответов: ${totalQuestions > 0 ? ((answeredQuestions / totalQuestions) * 100).toFixed(1) : 0}%\n\n`;

        message += `📅 <b>ПОСЛЕДНИЕ ВОПРОСЫ</b>\n`;
        if (allQuestions.length > 0) {
          allQuestions.slice(0, 5).forEach((q, index) => {
            const date = q.date ? new Date(q.date).toLocaleDateString('ru-RU') : 'н/д';
            const status = q.status === 'answered' ? '✅' : q.status === 'pending' ? '⏳' : '❓';
            const questionText = q.question ? (q.question.length > 50 ? q.question.substring(0, 50) + '...' : q.question) : 'Нет текста';
            message += `${index + 1}. ${status} ${q.userName}\n`;
            message += `   📅 ${date}: ${questionText}\n`;
          });
          
          if (allQuestions.length > 5) {
            message += `\n📋 ... и еще ${allQuestions.length - 5} вопросов\n`;
          }
        } else {
          message += `❌ Нет вопросов от пользователей\n`;
        }

        keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback('⏳ Ожидающие ответа', 'report_pending_questions'),
            Markup.button.callback('✅ Отвеченные', 'report_answered_questions')
          ],
          [
            Markup.button.callback('🔄 Обновить', 'report_refresh_questions'),
            Markup.button.callback('📊 Сводка', 'report_summary')
          ],
          [
            Markup.button.callback('🔙 Назад к аналитике', 'admin_analytics')
          ]
        ]);
        break;

      case 'tattoos':
        // Детальный отчет по татуировкам
        const tattooUsers = await ctx.db.User.find({ 
          tattooDate: { $ne: null, $exists: true } 
        }).sort({ tattooDate: -1 });

        message = `🎨 <b>ДЕТАЛЬНЫЙ ОТЧЕТ - ТАТУИРОВКИ</b>\n\n`;
        
        message += `📊 <b>СТАТИСТИКА ТАТУ</b>\n`;
        message += `• Пользователей с тату: ${tattooUsers.length}\n\n`;

        // Анализируем "возраст" татуировок
        const now = new Date();
        const ageCategories = {
          '0-7 дней': 0,
          '8-30 дней': 0,
          '1-3 месяца': 0,
          '3-12 месяцев': 0,
          'более года': 0
        };

        tattooUsers.forEach(user => {
          if (user.tattooDate) {
            const tattooDate = new Date(user.tattooDate);
            const daysDiff = Math.floor((now - tattooDate) / (1000 * 60 * 60 * 24));
            
            if (daysDiff <= 7) ageCategories['0-7 дней']++;
            else if (daysDiff <= 30) ageCategories['8-30 дней']++;
            else if (daysDiff <= 90) ageCategories['1-3 месяца']++;
            else if (daysDiff <= 365) ageCategories['3-12 месяцев']++;
            else ageCategories['более года']++;
          }
        });

        message += `📅 <b>РАСПРЕДЕЛЕНИЕ ПО ВОЗРАСТУ</b>\n`;
        Object.entries(ageCategories).forEach(([category, count]) => {
          const percentage = tattooUsers.length > 0 ? ((count / tattooUsers.length) * 100).toFixed(1) : 0;
          message += `• ${category}: ${count} (${percentage}%)\n`;
        });

        message += `\n🎯 <b>ПОСЛЕДНИЕ ТАТУИРОВКИ</b>\n`;
        if (tattooUsers.length > 0) {
          tattooUsers.slice(0, 5).forEach((user, index) => {
            if (user.tattooDate) {
              const tattooDate = new Date(user.tattooDate);
              const daysAgo = Math.floor((now - tattooDate) / (1000 * 60 * 60 * 24));
              const dateStr = tattooDate.toLocaleDateString('ru-RU');
              message += `${index + 1}. ${user.firstName || 'Аноним'}\n`;
              message += `   📅 ${dateStr} (${daysAgo} дней назад)\n`;
            }
          });
        } else {
          message += `❌ Нет данных о татуировках\n`;
        }

        keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback('📅 По датам', 'report_tattoo_dates'),
            Markup.button.callback('📈 Анализ трендов', 'report_tattoo_trends')
          ],
          [
            Markup.button.callback('🔄 Обновить', 'report_refresh_tattoos'),
            Markup.button.callback('📊 Сводка', 'report_summary')
          ],
          [
            Markup.button.callback('🔙 Назад к аналитике', 'admin_analytics')
          ]
        ]);
        break;

      case 'full':
        // Полный отчет (комбинация всех данных)
        const [fullTotalUsers, fullTattooUsers, fullQuestionUsers, weekActivity] = await Promise.all([
          ctx.db.User.countDocuments({}),
          ctx.db.User.countDocuments({ tattooDate: { $ne: null, $exists: true } }),
          ctx.db.User.countDocuments({ 'questions.0': { $exists: true } }),
          ctx.db.User.countDocuments({ 
            lastActive: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } 
          })
        ]);

        message = `📊 <b>ПОЛНЫЙ ОТЧЕТ</b>\n\n`;
        
        message += `📅 <b>ДАТА СОСТАВЛЕНИЯ:</b> ${new Date().toLocaleString('ru-RU')}\n\n`;
        
        message += `👥 <b>ПОЛЬЗОВАТЕЛИ</b>\n`;
        message += `• Всего: ${fullTotalUsers}\n`;
        message += `• С тату: ${fullTattooUsers} (${fullTotalUsers > 0 ? ((fullTattooUsers / fullTotalUsers) * 100).toFixed(1) : 0}%)\n`;
        message += `• С вопросами: ${fullQuestionUsers} (${fullTotalUsers > 0 ? ((fullQuestionUsers / fullTotalUsers) * 100).toFixed(1) : 0}%)\n`;
        message += `• Активных (7 дней): ${weekActivity} (${fullTotalUsers > 0 ? ((weekActivity / fullTotalUsers) * 100).toFixed(1) : 0}%)\n\n`;
        
        message += `📈 <b>ВЫВОДЫ И РЕКОМЕНДАЦИИ</b>\n`;
        
        if (fullTattooUsers < fullTotalUsers * 0.3) {
          message += `• ❌ Мало пользователей указали дату тату. Активно предлагайте /setdate\n`;
        } else {
          message += `• ✅ Хороший процент пользователей с указанной датой тату\n`;
        }
        
        if (weekActivity < fullTotalUsers * 0.2) {
          message += `• ❌ Низкая активность. Рассмотрите рассылку для вовлечения\n`;
        } else {
          message += `• ✅ Активность пользователей на хорошем уровне\n`;
        }
        
        if (fullQuestionUsers < fullTotalUsers * 0.1) {
          message += `• ❌ Мало вопросов от пользователей. Стимулируйте к общению\n`;
        } else {
          message += `• ✅ Пользователи активно задают вопросы\n`;
        }
        
        message += `\n💡 <b>РЕКОМЕНДУЕМЫЕ ДЕЙСТВИЯ</b>\n`;
        message += `1. Проверьте очередь вопросов и ответьте на ожидающие\n`;
        message += `2. Проанализируйте графики активности для лучшего тайминга рассылок\n`;
        message += `3. Рассмотрите возможность автоматических напоминаний\n`;

        keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback('📋 Экспорт данных', 'report_export'),
            Markup.button.callback('📊 Все графики', 'admin_charts')
          ],
          [
            Markup.button.callback('🔄 Обновить отчет', 'report_refresh_full'),
            Markup.button.callback('📢 Рассылка', 'admin_broadcast')
          ],
          [
            Markup.button.callback('🔙 Назад к аналитике', 'admin_analytics')
          ]
        ]);
        break;

      default:
        message = '❌ Неизвестный тип отчета';
        keyboard = Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Назад', 'admin_analytics')]
        ]);
    }

    if (ctx.updateType === 'callback_query') {
      try {
        await ctx.editMessageText(message, {
          parse_mode: 'HTML',
          ...keyboard
        });
        await ctx.answerCbQuery();
        return true;
      } catch (editError) {
        if (editError.response && editError.response.description && 
            editError.response.description.includes('message is not modified')) {
          console.log('ℹ️ Сообщение не изменилось, пропускаем ошибку');
          await ctx.answerCbQuery();
          return true;
        }
        throw editError;
      }
    } else {
      await ctx.replyWithHTML(message, keyboard);
      return true;
    }

  } catch (error) {
    console.error('Ошибка при построении детального отчета:', error);
    addToSystemLog(`Ошибка при построении детального отчета: ${error.message}`, 'ERROR');
    
    const errorMessage = `❌ <b>Ошибка при построении детального отчета</b>\n\n` +
      `Не удалось получить данные: ${error.message}`;
    
    if (ctx.updateType === 'callback_query') {
      try {
        await ctx.editMessageText(errorMessage, {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Повторить', 'admin_detailed_report')],
            [Markup.button.callback('🔙 Назад', 'admin_analytics')]
          ])
        });
        await ctx.answerCbQuery('❌ Ошибка');
      } catch (editError) {
        await ctx.answerCbQuery('❌ Ошибка загрузки');
      }
    } else {
      await ctx.reply(errorMessage);
    }
    return false;
  }
}

// Функция для отображения графика дат татуировок
async function showTattooDatesChart(ctx, period = '7days', isRefresh = false) {
  try {
    const ADMIN_ID = 1427347068;
    if (ctx.from.id !== ADMIN_ID) return;

    addToSystemLog(`Админ ${ctx.from.id} запросил график дат татуировок (период: ${period})`, 'ADMIN_ACTION');

    // Определяем период
    let days, periodName;
    switch (period) {
      case '7days':
        days = 7;
        periodName = '7 дней';
        break;
      case '30days':
        days = 30;
        periodName = '30 дней';
        break;
      case '90days':
        days = 90;
        periodName = '90 дней';
        break;
      default:
        days = 7;
        periodName = '7 дней';
    }

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // Получаем пользователей с указанной датой тату
    const usersWithTattoo = await ctx.db.User.find({
      tattooDate: { $ne: null, $exists: true }
    });

    // Получаем общую статистику
    const totalUsers = await ctx.db.User.countDocuments({});
    const usersWithTattooCount = usersWithTattoo.length;
    const tattooPercentage = totalUsers > 0 ? ((usersWithTattooCount / totalUsers) * 100).toFixed(1) : 0;

    // Группируем по дням (татуировки, сделанные в этот период)
    let tattoosByDay = {};
    
    // Инициализируем объект для каждого дня
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      date.setHours(0, 0, 0, 0);
      const dateKey = date.toISOString().split('T')[0];
      tattoosByDay[dateKey] = { count: 0, users: [] };
    }

    // Обрабатываем данные о татуировках
    let tattooData = [];
    let maxDailyCount = 0;
    let totalTattoosInPeriod = 0;

    usersWithTattoo.forEach(user => {
      if (user.tattooDate) {
        const tattooDate = new Date(user.tattooDate);
        tattooDate.setHours(0, 0, 0, 0);
        const dateKey = tattooDate.toISOString().split('T')[0];
        
        // Проверяем, попадает ли тату в анализируемый период
        if (tattooDate >= startDate && tattooDate <= endDate) {
          if (tattoosByDay[dateKey]) {
            tattoosByDay[dateKey].count++;
            tattoosByDay[dateKey].users.push({
              id: user.telegramId,
              name: user.firstName || `ID:${user.telegramId}`,
              date: user.tattooDate
            });
            totalTattoosInPeriod++;
          }
        }

        // Сохраняем все данные для статистики
        const daysSinceTattoo = Math.floor((new Date() - tattooDate) / (1000 * 60 * 60 * 24));
        tattooData.push({
          date: user.tattooDate,
          daysSince: daysSinceTattoo,
          userId: user.telegramId,
          userName: user.firstName || `ID:${user.telegramId}`
        });
      }
    });

    // Подготавливаем данные для графика
    let chartData = [];
    
    // Заполняем данные для каждого дня
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toLocaleDateString('ru-RU', { 
        weekday: 'short',
        day: '2-digit', 
        month: '2-digit' 
      });
      
      const dateKey = date.toISOString().split('T')[0];
      const dayData = tattoosByDay[dateKey] || { count: 0, users: [] };
      
      chartData.push({ 
        date: dateStr, 
        count: dayData.count,
        fullDate: date,
        users: dayData.users
      });
      
      maxDailyCount = Math.max(maxDailyCount, dayData.count);
    }

    // Анализируем "возраст" татуировок
    let tattooAgeStats = {
      fresh: 0,      // 0-7 дней
      healing: 0,    // 8-30 дней
      recent: 0,     // 1-3 месяца
      mature: 0,     // 3-12 месяцев
      old: 0         // больше года
    };

    tattooData.forEach(tattoo => {
      if (tattoo.daysSince <= 7) tattooAgeStats.fresh++;
      else if (tattoo.daysSince <= 30) tattooAgeStats.healing++;
      else if (tattoo.daysSince <= 90) tattooAgeStats.recent++;
      else if (tattoo.daysSince <= 365) tattooAgeStats.mature++;
      else tattooAgeStats.old++;
    });

    // Анализируем дни недели
    const weekdays = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
    const weekdayStats = {};
    tattooData.forEach(tattoo => {
      const tattooDate = new Date(tattoo.date);
      const weekday = weekdays[tattooDate.getDay()];
      weekdayStats[weekday] = (weekdayStats[weekday] || 0) + 1;
    });

    // Строим ASCII график
    let chart = '';
    const maxBarLength = 20;
    
    chartData.forEach(item => {
      const barLength = maxDailyCount > 0 ? Math.round((item.count / maxDailyCount) * maxBarLength) : 0;
      const bar = '█'.repeat(barLength) + '░'.repeat(maxBarLength - barLength);
      chart += `${item.date}: ${bar} ${item.count}\n`;
    });

    // Формируем сообщение
    let message = `🎨 <b>ГРАФИК ДАТ ТАТУИРОВОК (${periodName})</b>\n\n`;
    
    // Добавляем время обновления при refresh
    if (isRefresh) {
      const updateTime = new Date();
      const timeString = updateTime.toLocaleTimeString('ru-RU');
      message += `🕒 <b>Обновлено:</b> ${timeString}\n\n`;
    }
    
    message += `📅 Период анализа: ${startDate.toLocaleDateString('ru-RU')} - ${endDate.toLocaleDateString('ru-RU')}\n`;
    message += `👥 Всего пользователей: ${totalUsers}\n`;
    message += `🎨 С указанной датой тату: ${usersWithTattooCount} (${tattooPercentage}%)\n`;
    message += `📈 Тату за период: ${totalTattoosInPeriod}\n\n`;
    
    message += `<pre>${chart}</pre>\n`;
    
    message += `📊 <b>Статистика по датам тату:</b>\n`;
    
    // Находим день с максимальным количеством тату
    const mostTattoosDay = chartData.reduce((max, item) => item.count > max.count ? item : max, {count: 0});
    message += `• Максимум тату в день: ${mostTattoosDay.date} (${mostTattoosDay.count})\n`;
    
    // Дни без тату
    const daysWithoutTattoos = chartData.filter(item => item.count === 0).length;
    message += `• Дней без новых тату: ${daysWithoutTattoos}\n`;
    
    // Среднее количество тату в дни с тату
    const daysWithTattoos = days - daysWithoutTattoos;
    const avgTattoosPerDay = daysWithTattoos > 0 ? (totalTattoosInPeriod / daysWithTattoos).toFixed(1) : 0;
    message += `• Среднее в дни с тату: ${avgTattoosPerDay}\n\n`;
    
    // Статистика по "возрасту" татуировок
    if (usersWithTattooCount > 0) {
      message += `📅 <b>Возраст татуировок:</b>\n`;
      message += `• Свежие (0-7 дней): ${tattooAgeStats.fresh} (${((tattooAgeStats.fresh / usersWithTattooCount) * 100).toFixed(1)}%)\n`;
      message += `• Заживающие (8-30 дней): ${tattooAgeStats.healing} (${((tattooAgeStats.healing / usersWithTattooCount) * 100).toFixed(1)}%)\n`;
      message += `• Недавние (1-3 мес): ${tattooAgeStats.recent} (${((tattooAgeStats.recent / usersWithTattooCount) * 100).toFixed(1)}%)\n`;
      message += `• Зрелые (3-12 мес): ${tattooAgeStats.mature} (${((tattooAgeStats.mature / usersWithTattooCount) * 100).toFixed(1)}%)\n`;
      message += `• Старые (>1 года): ${tattooAgeStats.old} (${((tattooAgeStats.old / usersWithTattooCount) * 100).toFixed(1)}%)\n\n`;
    }
    
    // Статистика по дням недели
    if (Object.keys(weekdayStats).length > 0) {
      message += `📆 <b>Популярные дни недели для тату:</b>\n`;
      Object.entries(weekdayStats)
        .sort(([,a], [,b]) => b - a)
        .forEach(([weekday, count]) => {
          const percentage = ((count / usersWithTattooCount) * 100).toFixed(1);
          message += `• ${weekday}: ${count} (${percentage}%)\n`;
        });
      message += `\n`;
    }
    
    // Если есть тату за период, показываем детали
    if (totalTattoosInPeriod > 0) {
      message += `📋 <b>Тату за период (детали):</b>\n`;
      
      // Показываем последние 5 тату за период
      const recentTattoos = tattooData
        .filter(t => new Date(t.date) >= startDate)
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 5);
      
      if (recentTattoos.length > 0) {
        recentTattoos.forEach((tattoo, index) => {
          const tattooDate = new Date(tattoo.date).toLocaleDateString('ru-RU');
          message += `${index + 1}. ${tattoo.userName}: ${tattooDate} (${tattoo.daysSince} дн.)\n`;
        });
        message += `\n`;
      }
    }

    // Создаем клавиатуру с выбором периода
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(period === '7days' ? '✅ 7 дней' : '7 дней', 'chart_tattoo_7days'),
        Markup.button.callback(period === '30days' ? '✅ 30 дней' : '30 дней', 'chart_tattoo_30days'),
        Markup.button.callback(period === '90days' ? '✅ 90 дней' : '90 дней', 'chart_tattoo_90days')
      ],
      [
        Markup.button.callback('🔄 Обновить', `chart_tattoo_refresh_${period}`),
        Markup.button.callback('❓ Вопросы', 'chart_questions')
      ],
      [
        Markup.button.callback('📊 Другие графики', 'admin_charts'),
        Markup.button.callback('🔙 Назад к аналитике', 'admin_analytics')
      ]
    ]);

    if (ctx.updateType === 'callback_query') {
      try {
        await ctx.editMessageText(message, {
          parse_mode: 'HTML',
          ...keyboard
        });
        await ctx.answerCbQuery();
        return true;
      } catch (editError) {
        // Если ошибка "message not modified", просто игнорируем
        if (editError.response && editError.response.description && 
            editError.response.description.includes('message is not modified')) {
          console.log('ℹ️ Сообщение не изменилось, пропускаем ошибку');
          await ctx.answerCbQuery();
          return true;
        }
        throw editError;
      }
    } else {
      await ctx.replyWithHTML(message, keyboard);
      return true;
    }

  } catch (error) {
    console.error('Ошибка при построении графика дат тату:', error);
    addToSystemLog(`Ошибка при построении графика дат тату: ${error.message}`, 'ERROR');
    
    const errorMessage = `❌ <b>Ошибка при построении графика дат тату</b>\n\n` +
      `Не удалось получить данные: ${error.message}`;
    
    if (ctx.updateType === 'callback_query') {
      try {
        await ctx.editMessageText(errorMessage, {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Повторить', 'chart_tattoo_dates')],
            [Markup.button.callback('🔙 Назад', 'admin_charts')]
          ])
        });
        await ctx.answerCbQuery('❌ Ошибка');
      } catch (editError) {
        await ctx.answerCbQuery('❌ Ошибка загрузки');
      }
    } else {
      await ctx.reply(errorMessage);
    }
    return false;
  }
}

// Функция для рассылки пользователям с указанной датой татуировки
async function startBroadcastToTattooUsers(ctx, messageText) {
  try {
    const ADMIN_ID = 1427347068;
    if (ctx.from.id !== ADMIN_ID) {
      return false;
    }

    console.log(`🎯 Админ ${ctx.from.id} начинает рассылку пользователям с датой тату`);

    // Сбрасываем состояние
    broadcastState.isActive = true;
    broadcastState.currentAdminId = ctx.from.id;
    broadcastState.messageText = messageText;
    broadcastState.totalUsers = 0;
    broadcastState.successCount = 0;
    broadcastState.failedCount = 0;
    broadcastState.startTime = new Date();

    // Получаем пользователей С датой татуировки
    const users = await ctx.db.User.find({ 
      tattooDate: { $ne: null, $exists: true } 
    });
    broadcastState.totalUsers = users.length;

    // Получаем общее количество для статистики
    const totalUsers = await ctx.db.User.countDocuments({});
    const tattooUsersPercentage = totalUsers > 0 ? Math.round((users.length / totalUsers) * 100) : 0;

    // Если пользователей с датой тату нет
    if (users.length === 0) {
      broadcastState.isActive = false;
      await ctx.reply('❌ <b>Нет пользователей с датой татуировки</b>\n\n' +
        'В базе данных нет пользователей с указанной датой татуировки.\n\n' +
        '📊 <b>Статистика:</b>\n' +
        `• Всего пользователей: ${totalUsers}\n` +
        `• С датой тату: ${users.length} (${tattooUsersPercentage}%)\n\n` +
        '💡 <b>Совет:</b> Проверьте, чтобы пользователи указали дату через /setdate',
        { parse_mode: 'HTML' });
      return false;
    }

    // Отправляем сообщение о начале рассылки
    const startMessage = await ctx.replyWithHTML(
      `🎯 <b>РАССЫЛКА ПОЛЬЗОВАТЕЛЯМ С ДАТОЙ ТАТУ</b>\n\n` +
      `📝 <b>Сообщение:</b>\n${messageText.substring(0, 200)}${messageText.length > 200 ? '...' : ''}\n\n` +
      `📊 <b>Целевая аудитория:</b>\n` +
      `• Всего пользователей: ${totalUsers}\n` +
      `• С датой тату: ${users.length} (${tattooUsersPercentage}%)\n\n` +
      `⏱️ <b>Начало:</b> ${broadcastState.startTime.toLocaleTimeString('ru-RU')}\n\n` +
      `🔄 <b>Рассылка началась...</b>`
    );

    let progressMessageId = startMessage.message_id;

    // Функция обновления прогресса
    const updateProgress = async () => {
      if (!broadcastState.isActive) return;

      const progress = Math.round((broadcastState.successCount + broadcastState.failedCount) / broadcastState.totalUsers * 100);
      const elapsed = Math.floor((new Date() - broadcastState.startTime) / 1000);
      const remaining = users.length - (broadcastState.successCount + broadcastState.failedCount);
      
      // Получаем примерные данные о пользователях для отчета
      let sampleUsers = '';
      if (users.length > 0) {
        const sample = users.slice(0, Math.min(3, users.length));
        sampleUsers = sample.map(u => u.firstName || `ID:${u.telegramId}`).join(', ');
        if (users.length > 3) sampleUsers += ` и еще ${users.length - 3}`;
      }

      try {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          progressMessageId,
          null,
          `🎯 <b>РАССЫЛКА ПОЛЬЗОВАТЕЛЯМ С ТАТУ</b>\n\n` +
          `📝 <b>Сообщение:</b>\n${broadcastState.messageText.substring(0, 120)}${broadcastState.messageText.length > 120 ? '...' : ''}\n\n` +
          `📊 <b>Прогресс:</b> ${progress}%\n` +
          `✅ <b>Успешно:</b> ${broadcastState.successCount}\n` +
          `❌ <b>Не удалось:</b> ${broadcastState.failedCount}\n` +
          `🎨 <b>С датой тату:</b> ${users.length}\n` +
          `⏱️ <b>Прошло времени:</b> ${elapsed} сек\n` +
          `📋 <b>Осталось:</b> ${remaining}\n\n` +
          `👥 <b>Пример получателей:</b> ${sampleUsers || 'нет данных'}\n\n` +
          `🔄 <b>Рассылка продолжается...</b>`,
          { parse_mode: 'HTML' }
        );
      } catch (error) {
        console.error('Ошибка при обновлении прогресса рассылки тату:', error);
      }
    };

    // Отправляем сообщения пользователям
    for (let i = 0; i < users.length; i++) {
      if (!broadcastState.isActive) break;

      const user = users[i];
      
      try {
        // Пропускаем администратора, если это не нужно
        if (user.telegramId === ADMIN_ID) {
          broadcastState.successCount++;
          continue;
        }

        // Рассчитываем сколько дней прошло с татуировки
        let daysInfo = '';
        if (user.tattooDate) {
          const tattooDate = new Date(user.tattooDate);
          const daysPassed = Math.floor((new Date() - tattooDate) / (1000 * 60 * 60 * 24));
          daysInfo = `\n\n🎨 <b>Ваша татуировка:</b> ${daysPassed} дней\n`;
        }

        await ctx.telegram.sendMessage(
          user.telegramId,
          `🎯 <b>СООБЩЕНИЕ ДЛЯ ВЛАДЕЛЬЦЕВ ТАТУИРОВОК</b>\n\n` +
          `${messageText}\n` +
          `${daysInfo}\n` +
          `— Администрация бота`,
          { parse_mode: 'HTML' }
        );
        
        broadcastState.successCount++;
        
        // Обновляем прогресс каждые 5 отправок или каждые 3 секунды
        if (i % 5 === 0 || i === users.length - 1) {
          await updateProgress();
        }
        
        // Задержка между сообщениями
        await new Promise(resolve => setTimeout(resolve, 150));
        
      } catch (error) {
        console.error(`Ошибка отправки пользователю с тату ${user.telegramId}:`, error.message);
        broadcastState.failedCount++;
        
        // Если пользователь заблокировал бота, удаляем его из БД
        if (error.response && error.response.error_code === 403) {
          try {
            await ctx.db.User.deleteOne({ telegramId: user.telegramId });
            console.log(`Пользователь с тату ${user.telegramId} заблокировал бота, удален из БД`);
          } catch (deleteError) {
            console.error('Ошибка при удалении пользователя с тату:', deleteError);
          }
        }
      }
    }

    // Завершение рассылки
    broadcastState.endTime = new Date();
    broadcastState.isActive = false;
    
    const totalTime = Math.floor((broadcastState.endTime - broadcastState.startTime) / 1000);
    const successRate = Math.round((broadcastState.successCount / broadcastState.totalUsers) * 100);

    // Финальное сообщение
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      progressMessageId,
      null,
      `✅ <b>РАССЫЛКА ЗАВЕРШЕНА</b>\n\n` +
      `🎯 <b>Целевая аудитория:</b> Пользователи с датой татуировки\n\n` +
      `📊 <b>Результаты:</b>\n` +
      `• Всего пользователей в базе: ${totalUsers}\n` +
      `• Пользователей с датой тату: ${users.length} (${tattooUsersPercentage}%)\n` +
      `• Успешно отправлено: ${broadcastState.successCount}\n` +
      `• Не удалось отправить: ${broadcastState.failedCount}\n` +
      `• Процент успеха: ${successRate}%\n\n` +
      `⏱️ <b>Время:</b>\n` +
      `• Начало: ${broadcastState.startTime.toLocaleTimeString('ru-RU')}\n` +
      `• Завершение: ${broadcastState.endTime.toLocaleTimeString('ru-RU')}\n` +
      `• Общее время: ${totalTime} секунд\n\n` +
      `💡 <b>Аналитика:</b>\n` +
      `Это сегмент пользователей, которые активно используют бота для ухода за татуировками.`,
      { parse_mode: 'HTML' }
    );

    console.log(`✅ Рассылка пользователям с тату завершена. Успешно: ${broadcastState.successCount}/${users.length}`);
    return true;

  } catch (error) {
    console.error('❌ Критическая ошибка при рассылке тату:', error);
    
    broadcastState.isActive = false;
    
    await ctx.reply(
      `❌ <b>ОШИБКА ПРИ РАССЫЛКЕ ПОЛЬЗОВАТЕЛЯМ С ТАТУ</b>\n\n` +
      `Произошла критическая ошибка: ${error.message}\n\n` +
      `Рассылка прервана. Частично отправлено: ${broadcastState.successCount} сообщений.`,
      { parse_mode: 'HTML' }
    );
    
    return false;
  }
}

// ========== ОБРАБОТЧИКИ ДЛЯ НАСТРОЙКИ УВЕДОМЛЕНИЙ ==========

// 1. Основной обработчик для кнопки "Уведомления"
bot.action('admin_settings_notifications', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  addToSystemLog(`Админ ${ctx.from.id} открыл настройки уведомлений`, 'ADMIN_ACTION');
  
  await showNotificationSettings(ctx);
});

// 2. Переключение всех уведомлений
bot.action('admin_notifications_toggle', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) return;
  
  if (!systemCache.adminNotificationSettings) {
    systemCache.adminNotificationSettings = {
      enabled: true,
      types: {
        newUsers: true,
        newQuestions: true,
        errors: true,
        systemAlerts: true,
        broadcastResults: true
      }
    };
  }
  
  systemCache.adminNotificationSettings.enabled = !systemCache.adminNotificationSettings.enabled;
  systemCache.adminNotificationSettings.lastUpdated = new Date();
  
  addToSystemLog(`Админ ${ctx.from.id} ${systemCache.adminNotificationSettings.enabled ? 'включил' : 'выключил'} все уведомления`, 'ADMIN_ACTION');
  
  await showNotificationSettings(ctx, true);
});

// 3. Обработчики для отдельных типов уведомлений (регулярное выражение)
bot.action(/admin_notif_toggle_(\w+)/, async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) return;
  
  const notificationType = ctx.match[1];
  
  if (!systemCache.adminNotificationSettings) {
    systemCache.adminNotificationSettings = {
      enabled: true,
      types: {
        newUsers: true,
        newQuestions: true,
        errors: true,
        systemAlerts: true,
        broadcastResults: true
      }
    };
  }
  
  if (systemCache.adminNotificationSettings.types[notificationType] !== undefined) {
    systemCache.adminNotificationSettings.types[notificationType] = !systemCache.adminNotificationSettings.types[notificationType];
    systemCache.adminNotificationSettings.lastUpdated = new Date();
    
    const typeNames = {
      newUsers: 'новые пользователи',
      newQuestions: 'новые вопросы',
      errors: 'ошибки системы',
      systemAlerts: 'системные алерты',
      broadcastResults: 'результаты рассылок'
    };
    
    addToSystemLog(
      `Админ ${ctx.from.id} ${systemCache.adminNotificationSettings.types[notificationType] ? 'включил' : 'выключил'} уведомления: ${typeNames[notificationType] || notificationType}`,
      'ADMIN_ACTION'
    );
  }
  
  await showNotificationSettings(ctx, true);
});

// 4. Обновление настроек уведомлений
bot.action('admin_notifications_refresh', async (ctx) => {
  await ctx.answerCbQuery('🔄 Обновляю...');
  await showNotificationSettings(ctx, true);
});

// 5. Экспорт настроек в файл
bot.action('admin_notifications_export', async (ctx) => {
  await ctx.answerCbQuery('💾 Сохраняю настройки...');
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) return;
  
  try {
    const settingsData = JSON.stringify(systemCache.adminNotificationSettings || {}, null, 2);
    const fileName = `notification-settings-${new Date().toISOString().slice(0,10)}.json`;
    
    await ctx.replyWithDocument({
      source: Buffer.from(settingsData, 'utf8'),
      filename: fileName
    }, {
      caption: `💾 <b>Настройки уведомлений экспортированы</b>\n\n` +
               `📅 Дата: ${new Date().toLocaleString('ru-RU')}\n` +
               `👤 Администратор: ${ctx.from.id}`,
      parse_mode: 'HTML'
    });
    
    addToSystemLog(`Админ ${ctx.from.id} экспортировал настройки уведомлений`, 'ADMIN_ACTION');
    
  } catch (error) {
    console.error('Ошибка при экспорте настроек:', error);
    await ctx.answerCbQuery('❌ Ошибка при экспорте');
  }
});

// ========== ОБРАБОТЧИКИ АДМИН ПАНЕЛИ ==========

// 1. Статистика
bot.action('admin_stats', async (ctx) => {
  await ctx.answerCbQuery();

  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  await showUsersList(ctx, 1);
  
  const usersCount = await ctx.db.User.countDocuments({});
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayUsers = await ctx.db.User.countDocuments({
    createdAt: { $gte: today }
  });
  
  const usersWithTattoo = await ctx.db.User.countDocuments({
    tattooDate: { $ne: null }
  });
  
  const allUsers = await ctx.db.User.find({});
  let totalQuestions = 0;
  let pendingQuestions = 0;
  
  allUsers.forEach(user => {
    if (user.questions && Array.isArray(user.questions)) {
      totalQuestions += user.questions.length;
      pendingQuestions += user.questions.filter(q => q.status === 'pending').length;
    }
    
  });

  
  await ctx.editMessageText(
    `📊 <b>СТАТИСТИКА БОТА</b>\n\n` +
    `👥 <b>Всего пользователей:</b> ${usersCount}\n` +
    `📈 <b>Новых сегодня:</b> ${todayUsers}\n` +
    `🎨 <b>Указали дату тату:</b> ${usersWithTattoo}\n` +
    `❓ <b>Всего вопросов:</b> ${totalQuestions}\n` +
    `⏳ <b>В ожидании ответа:</b> ${pendingQuestions}\n\n` +
    `🔄 <b>Система:</b>\n` +
    `• Время: ${new Date().toLocaleString('ru-RU')}\n` +
    `• БД: ${mongoose.connection.readyState === 1 ? '✅' : '❌'}\n` +
    `• Node.js: ${process.version}`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('👥 Пользователи', 'admin_users'),
          Markup.button.callback('❓ Вопросы', 'admin_questions')
        ],
        [Markup.button.callback('🔙 Назад', 'admin_back')]
      ])
    }
  );
});
// 2. Пользователи (основной обработчик кнопки)
bot.action('admin_users', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  await showUsersList(ctx, 1);
});

// 3. Пользователи (обработка пагинации)
bot.action(/admin_users_page_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  const page = parseInt(ctx.match[1]);
  await showUsersList(ctx, page);
});

// 4. Обновление списка пользователей
bot.action(/admin_users_refresh_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  const page = parseInt(ctx.match[1]);
  await showUsersList(ctx, page, true); // true - это флаг обновления
});

// 3. Вопросы пользователей
bot.action('admin_questions', async (ctx) => {
  await ctx.answerCbQuery();
  
  const allUsers = await ctx.db.User.find({ 'questions.0': { $exists: true } });
  let pendingQuestions = [];
  
  allUsers.forEach(user => {
    if (user.questions && Array.isArray(user.questions)) {
      user.questions.forEach(q => {
        if (q.status === 'pending') {
          pendingQuestions.push({
            userId: user.telegramId,
            userName: user.firstName || 'Аноним',
            question: q.question,
            date: q.date,
            questionId: q._id
          });
        }
      });
    }
  });
  
  if (pendingQuestions.length === 0) {
    await ctx.editMessageText(
      '✅ Нет вопросов, ожидающих ответа.',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Назад', 'admin_back')]
        ])
      }
    );
    return;
  }
  
  let message = `❓ <b>ВОПРОСЫ В ОЖИДАНИИ</b> (${pendingQuestions.length})\n\n`;
  
  pendingQuestions.slice(0, 5).forEach((q, index) => {
    message += `<b>Вопрос ${index + 1}:</b>\n`;
    message += `👤 ${q.userName} (ID: ${q.userId})\n`;
    message += `📅 ${q.date?.toLocaleString('ru-RU') || 'н/д'}\n`;
    message += `💬 ${q.question.substring(0, 100)}${q.question.length > 100 ? '...' : ''}\n`;
    message += `────────────────────\n`;
  });
  
  if (pendingQuestions.length > 5) {
    message += `\n📋 <b>И еще ${pendingQuestions.length - 5} вопросов...</b>`;
  }
  
  await ctx.editMessageText(
    message,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('👥 Все вопросы', 'admin_all_questions'),
          Markup.button.callback('📊 Статистика', 'admin_stats')
        ],
        [Markup.button.callback('🔙 Назад', 'admin_back')]
      ])
    }
  );
});

// 4. Все вопросы пользователей (обработчик кнопки "Все вопросы")
bot.action('admin_all_questions', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  await showAllQuestionsList(ctx, 1);
});

// 4. Все вопросы (обработка пагинации)
bot.action(/admin_all_questions_page_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  const page = parseInt(ctx.match[1]);
  await showAllQuestionsList(ctx, page);
});

bot.action(/admin_all_questions_refresh_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  const page = parseInt(ctx.match[1]);
  await showAllQuestionsList(ctx, page, true); // true - это флаг обновления
});


// 5. Управление
bot.action('admin_manage', async (ctx) => {
  await ctx.answerCbQuery();
  
  await ctx.editMessageText(
    '🔧 <b>УПРАВЛЕНИЕ БОТОМ</b>\n\n' +
    'Выберите действие:',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🔄 Перезапустить', 'admin_restart'),
          Markup.button.callback('📝 Создать резервную копию', 'admin_backup')
        ],
        [
          Markup.button.callback('🧹 Очистить кэш', 'admin_clear_cache'),
          Markup.button.callback('📋 Логи', 'admin_logs')
        ],
        [
          Markup.button.callback('⚡ Проверить производительность', 'admin_performance'),
          Markup.button.callback('🔧 Настройки БД', 'admin_db_settings')
        ],
        [Markup.button.callback('🔙 Назад', 'admin_back')]
      ])
    }
  );
});

// 5. Рассылка
bot.action('admin_broadcast', async (ctx) => {
  await ctx.answerCbQuery();
  
  await ctx.editMessageText(
    '📢 <b>РАССЫЛКА СООБЩЕНИЙ</b>\n\n' +
    'Выберите тип рассылки:',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('📝 Всем пользователям', 'admin_broadcast_all'),
          Markup.button.callback('🎯 С датой тату', 'admin_broadcast_tattoo')
        ],
        [
          Markup.button.callback('❓ С вопросами', 'admin_broadcast_questions'),
          Markup.button.callback('📅 Активным (7 дней)', 'admin_broadcast_active')
        ],
        [Markup.button.callback('🔙 Назад', 'admin_back')]
      ])
    }
  );
});

// 6. Аналитика
bot.action('admin_analytics', async (ctx) => {
  await ctx.answerCbQuery();
  
  // Простая аналитика
  const users = await ctx.db.User.find({});
  let analytics = {
    total: users.length,
    withTattoo: 0,
    withQuestions: 0,
    activeToday: 0,
    activeWeek: 0,
    byStage: {}
  };
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  
  users.forEach(user => {
    if (user.tattooDate) analytics.withTattoo++;
    if (user.questions?.length > 0) analytics.withQuestions++;
    if (user.lastActive && user.lastActive >= today) analytics.activeToday++;
    if (user.lastActive && user.lastActive >= weekAgo) analytics.activeWeek++;
    
    const stage = user.stage || 'unknown';
    analytics.byStage[stage] = (analytics.byStage[stage] || 0) + 1;
  });
  
  await ctx.editMessageText(
    `📈 <b>АНАЛИТИКА</b>\n\n` +
    `👥 <b>Всего пользователей:</b> ${analytics.total}\n` +
    `🎨 <b>С датой тату:</b> ${analytics.withTattoo} (${Math.round((analytics.withTattoo / analytics.total) * 100)}%)\n` +
    `❓ <b>С вопросами:</b> ${analytics.withQuestions} (${Math.round((analytics.withQuestions / analytics.total) * 100)}%)\n` +
    `⏰ <b>Активных сегодня:</b> ${analytics.activeToday}\n` +
    `📅 <b>Активных за неделю:</b> ${analytics.activeWeek}\n\n` +
    `<b>Стадии пользователей:</b>\n` +
    Object.entries(analytics.byStage)
      .map(([stage, count]) => `• ${stage}: ${count}`)
      .join('\n'),
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('📊 Графики', 'admin_charts'),
          Markup.button.callback('📋 Детальный отчет', 'admin_detailed_report')
        ],
        [Markup.button.callback('🔙 Назад', 'admin_back')]
      ])
    }
  );
});

// 7. Настройки
bot.action('admin_settings', async (ctx) => {
  await ctx.answerCbQuery();
  
  await ctx.editMessageText(
    '⚙️ <b>НАСТРОЙКИ</b>\n\n' +
    'Выберите настройку для изменения:',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🔔 Уведомления', 'admin_settings_notifications'),
          Markup.button.callback('🌐 Язык', 'admin_settings_language')
        ],
        [
          Markup.button.callback('⏱️ Время работы', 'admin_settings_worktime'),
          Markup.button.callback('📝 Шаблоны ответов', 'admin_settings_templates')
        ],
        [
          Markup.button.callback('🔐 Доступ', 'admin_settings_access'),
          Markup.button.callback('📊 Лимиты', 'admin_settings_limits')
        ],
        [Markup.button.callback('🔙 Назад', 'admin_back')]
      ])
    }
  );
});

// 8. Назад в главное меню админки
bot.action('admin_back', async (ctx) => {
  await ctx.answerCbQuery();
  
  await ctx.editMessageText(
    '👑 <b>ПАНЕЛЬ АДМИНИСТРАТОРА</b>\n\n' +
    'Выберите действие:',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('📊 Статистика', 'admin_stats'),
          Markup.button.callback('👥 Пользователи', 'admin_users')
        ],
        [
          Markup.button.callback('❓ Вопросы пользователей', 'admin_questions'),
          Markup.button.callback('🔧 Управление', 'admin_manage')
        ],
        [
          Markup.button.callback('📢 Рассылка', 'admin_broadcast'),
          Markup.button.callback('📈 Аналитика', 'admin_analytics')
        ],
        [
          Markup.button.callback('⚙️ Настройки', 'admin_settings')
        ]
      ])
    }
  );
});

// ========== ОБРАБОТЧИКИ ГРАФИКА ПОЧАСОВОЙ АКТИВНОСТИ ==========

// Основной обработчик графика почасовой активности
bot.action('chart_hourly_activity', async (ctx) => {
  await ctx.answerCbQuery();
  await showHourlyActivityChart(ctx, '7days');
});

// Обработчики для разных периодов почасовой активности
bot.action('chart_hourly_7days', async (ctx) => {
  await ctx.answerCbQuery();
  await showHourlyActivityChart(ctx, '7days');
});

bot.action('chart_hourly_30days', async (ctx) => {
  await ctx.answerCbQuery();
  await showHourlyActivityChart(ctx, '30days');
});

bot.action('chart_hourly_90days', async (ctx) => {
  await ctx.answerCbQuery();
  await showHourlyActivityChart(ctx, '90days');
});

// Обновление графика почасовой активности
bot.action(/chart_hourly_refresh_(\w+)/, async (ctx) => {
  await ctx.answerCbQuery('🔄 Обновляю график почасовой активности...');
  const period = ctx.match[1];
  await showHourlyActivityChart(ctx, period, true);
});


// ========== ОБРАБОТЧИКИ СВОДНОЙ АНАЛИТИКИ ==========

// Основной обработчик сводной аналитики
bot.action('chart_summary', async (ctx) => {
  await ctx.answerCbQuery();
  await showSummaryChart(ctx);
});

// Обновление сводной аналитики
bot.action('chart_summary_refresh', async (ctx) => {
  await ctx.answerCbQuery('🔄 Обновляю сводную аналитику...');
  await showSummaryChart(ctx, true);
});

// ========== ОБРАБОТЧИКИ ГРАФИКА ВОПРОСОВ ==========

// Основной обработчик графика вопросов
bot.action('chart_questions', async (ctx) => {
  await ctx.answerCbQuery();
  await showQuestionsChart(ctx, '7days');
});

// Обработчики для разных периодов вопросов
bot.action('chart_questions_7days', async (ctx) => {
  await ctx.answerCbQuery();
  await showQuestionsChart(ctx, '7days');
});

bot.action('chart_questions_30days', async (ctx) => {
  await ctx.answerCbQuery();
  await showQuestionsChart(ctx, '30days');
});

bot.action('chart_questions_90days', async (ctx) => {
  await ctx.answerCbQuery();
  await showQuestionsChart(ctx, '90days');
});

// Обновление графика вопросов
bot.action(/chart_questions_refresh_(\w+)/, async (ctx) => {
  await ctx.answerCbQuery('🔄 Обновляю график вопросов...');
  const period = ctx.match[1];
  await showQuestionsChart(ctx, period, true);
});

// ========== ОБРАБОТЧИКИ ГРАФИКА ДАТ ТАТУИРОВОК ==========

// Основной обработчик графика дат татуировок
bot.action('chart_tattoo_dates', async (ctx) => {
  await ctx.answerCbQuery();
  await showTattooDatesChart(ctx, '7days');
});

// Обработчики для разных периодов дат тату
bot.action('chart_tattoo_7days', async (ctx) => {
  await ctx.answerCbQuery();
  await showTattooDatesChart(ctx, '7days');
});

bot.action('chart_tattoo_30days', async (ctx) => {
  await ctx.answerCbQuery();
  await showTattooDatesChart(ctx, '30days');
});

bot.action('chart_tattoo_90days', async (ctx) => {
  await ctx.answerCbQuery();
  await showTattooDatesChart(ctx, '90days');
});

// Обновление графика дат тату
bot.action(/chart_tattoo_refresh_(\w+)/, async (ctx) => {
  await ctx.answerCbQuery('🔄 Обновляю график дат тату...');
  const period = ctx.match[1];
  await showTattooDatesChart(ctx, period, true);
});

// ========== ОБРАБОТЧИКИ ДЕТАЛЬНОГО ОТЧЕТА ==========

// Основной обработчик детального отчета
bot.action('admin_detailed_report', async (ctx) => {
  await ctx.answerCbQuery();
  await showDetailedReport(ctx, 'summary');
});

// Обработчики для разных типов отчетов
bot.action('report_summary', async (ctx) => {
  await ctx.answerCbQuery();
  await showDetailedReport(ctx, 'summary');
});

bot.action('report_users', async (ctx) => {
  await ctx.answerCbQuery();
  await showDetailedReport(ctx, 'users');
});

bot.action('report_questions', async (ctx) => {
  await ctx.answerCbQuery();
  await showDetailedReport(ctx, 'questions');
});

bot.action('report_tattoos', async (ctx) => {
  await ctx.answerCbQuery();
  await showDetailedReport(ctx, 'tattoos');
});

bot.action('report_full', async (ctx) => {
  await ctx.answerCbQuery();
  await showDetailedReport(ctx, 'full');
});

// Дополнительные отчеты
bot.action('report_active_users', async (ctx) => {
  await ctx.answerCbQuery('👥 Этот раздел в разработке');
});

bot.action('report_top_questions', async (ctx) => {
  await ctx.answerCbQuery('❓ Этот раздел в разработке');
});

bot.action('report_pending_questions', async (ctx) => {
  await ctx.answerCbQuery('⏳ Этот раздел в разработке');
});

bot.action('report_answered_questions', async (ctx) => {
  await ctx.answerCbQuery('✅ Этот раздел в разработке');
});

bot.action('report_tattoo_dates', async (ctx) => {
  await ctx.answerCbQuery('📅 Этот раздел в разработке');
});

bot.action('report_tattoo_trends', async (ctx) => {
  await ctx.answerCbQuery('📈 Этот раздел в разработке');
});

bot.action('report_export', async (ctx) => {
  await ctx.answerCbQuery('📋 Этот раздел в разработке');
});

// Обновление отчетов
bot.action(/report_refresh_(\w+)/, async (ctx) => {
  await ctx.answerCbQuery('🔄 Обновляю отчет...');
  const reportType = ctx.match[1];
  await showDetailedReport(ctx, reportType, true);
});

// ========== ОБРАБОТЧИКИ ДЛЯ НАСТРОЙКИ ЯЗЫКА ==========

// 1. Основной обработчик для кнопки "Язык"
bot.action('admin_settings_language', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  addToSystemLog(`Админ ${ctx.from.id} открыл настройки языка`, 'ADMIN_ACTION');
  
  await showLanguageSettings(ctx);
});

// 2. Выбор русского языка
bot.action('admin_language_ru', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) return;
  
  if (!systemCache.adminLanguageSettings) {
    systemCache.adminLanguageSettings = {};
  }
  
  systemCache.adminLanguageSettings[ctx.from.id] = 'ru';
  
  addToSystemLog(`Админ ${ctx.from.id} установил русский язык`, 'ADMIN_ACTION');
  
  await showLanguageSettings(ctx, true);
  
  // Отправляем подтверждение
  await ctx.reply('✅ Язык изменен на Русский');
});

// 3. Выбор казахского языка
bot.action('admin_language_kz', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) return;
  
  if (!systemCache.adminLanguageSettings) {
    systemCache.adminLanguageSettings = {};
  }
  
  systemCache.adminLanguageSettings[ctx.from.id] = 'kz';
  
  addToSystemLog(`Админ ${ctx.from.id} установил казахский язык`, 'ADMIN_ACTION');
  
  await showLanguageSettings(ctx, true);
  
  // Отправляем подтверждение на казахском
  await ctx.reply('✅ Тіл Қазақ тіліне өзгертілді');
});

// 4. Выбор английского языка
bot.action('admin_language_en', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) return;
  
  if (!systemCache.adminLanguageSettings) {
    systemCache.adminLanguageSettings = {};
  }
  
  systemCache.adminLanguageSettings[ctx.from.id] = 'en';
  
  addToSystemLog(`Админ ${ctx.from.id} установил английский язык`, 'ADMIN_ACTION');
  
  await showLanguageSettings(ctx, true);
  
  // Отправляем подтверждение на английском
  await ctx.reply('✅ Language changed to English');
});

// 5. Обновление настроек языка
bot.action('admin_language_refresh', async (ctx) => {
  await ctx.answerCbQuery('🔄 Обновляю...');
  await showLanguageSettings(ctx, true);
});

// 6. Применение языка ко всем пользователям
bot.action('admin_language_apply_all', async (ctx) => {
  await ctx.answerCbQuery('📊 Применяю язык ко всем пользователям...');
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) return;
  
  try {
    // Получаем текущий язык администратора
    const currentLanguage = systemCache.adminLanguageSettings?.[ctx.from.id] || 'ru';
    
    // Обновляем язык для всех пользователей в базе данных
    const result = await ctx.db.User.updateMany(
      {},
      { $set: { 'settings.language': currentLanguage } }
    );
    
    addToSystemLog(`Админ ${ctx.from.id} применил язык ${currentLanguage} к ${result.modifiedCount} пользователям`, 'ADMIN_ACTION');
    
    await ctx.reply(
      `✅ Язык успешно применен ко всем пользователям\n\n` +
      `📊 Обновлено пользователей: ${result.modifiedCount}\n` +
      `🌐 Установленный язык: ${currentLanguage}`
    );
    
    // Обновляем интерфейс настроек языка
    await showLanguageSettings(ctx, true);
    
  } catch (error) {
    console.error('Ошибка при применении языка ко всем пользователям:', error);
    await ctx.answerCbQuery('❌ Ошибка при применении языка');
  }
});

// ========== ОБРАБОТЧИКИ ДЛЯ НАСТРОЙКИ РАБОЧЕГО ВРЕМЕНИ ==========

// 1. Основной обработчик для кнопки "Время работы"
bot.action('admin_settings_worktime', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  addToSystemLog(`Админ ${ctx.from.id} открыл настройки рабочего времени`, 'ADMIN_ACTION');
  
  await showWorktimeSettings(ctx);
});

// 2. Переключение режима работы
bot.action('admin_worktime_toggle', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) return;
  
  if (!systemCache.worktimeSettings) {
    systemCache.worktimeSettings = {
      enabled: true,
      workDays: [1, 2, 3, 4, 5],
      startHour: 9,
      startMinute: 0,
      endHour: 18,
      endMinute: 0,
      timezone: 'Asia/Almaty',
      notifications: {
        autoReply: true,
        offlineMessage: true,
        weekendMessage: true
      }
    };
  }
  
  systemCache.worktimeSettings.enabled = !systemCache.worktimeSettings.enabled;
  systemCache.worktimeSettings.lastUpdated = new Date();
  
  const status = systemCache.worktimeSettings.enabled ? 'включил' : 'выключил';
  addToSystemLog(`Админ ${ctx.from.id} ${status} режим рабочего времени`, 'ADMIN_ACTION');
  
  await showWorktimeSettings(ctx, true);
});

// 3. Изменение времени начала (часы)
bot.action('admin_worktime_start_hour_inc', async (ctx) => {
  await ctx.answerCbQuery();
  if (!systemCache.worktimeSettings) return;
  
  systemCache.worktimeSettings.startHour = (systemCache.worktimeSettings.startHour + 1) % 24;
  systemCache.worktimeSettings.lastUpdated = new Date();
  await showWorktimeSettings(ctx, true);
});

bot.action('admin_worktime_start_hour_dec', async (ctx) => {
  await ctx.answerCbQuery();
  if (!systemCache.worktimeSettings) return;
  
  systemCache.worktimeSettings.startHour = (systemCache.worktimeSettings.startHour - 1 + 24) % 24;
  systemCache.worktimeSettings.lastUpdated = new Date();
  await showWorktimeSettings(ctx, true);
});

// 4. Изменение времени окончания (часы)
bot.action('admin_worktime_end_hour_inc', async (ctx) => {
  await ctx.answerCbQuery();
  if (!systemCache.worktimeSettings) return;
  
  systemCache.worktimeSettings.endHour = (systemCache.worktimeSettings.endHour + 1) % 24;
  systemCache.worktimeSettings.lastUpdated = new Date();
  await showWorktimeSettings(ctx, true);
});

bot.action('admin_worktime_end_hour_dec', async (ctx) => {
  await ctx.answerCbQuery();
  if (!systemCache.worktimeSettings) return;
  
  systemCache.worktimeSettings.endHour = (systemCache.worktimeSettings.endHour - 1 + 24) % 24;
  systemCache.worktimeSettings.lastUpdated = new Date();
  await showWorktimeSettings(ctx, true);
});

// 5. Обработчики для выбора дней недели
bot.action(/admin_worktime_day_(\d)/, async (ctx) => {
  await ctx.answerCbQuery();
  
  const day = parseInt(ctx.match[1]);
  if (!systemCache.worktimeSettings) return;
  
  const index = systemCache.worktimeSettings.workDays.indexOf(day);
  if (index === -1) {
    systemCache.worktimeSettings.workDays.push(day);
  } else {
    systemCache.worktimeSettings.workDays.splice(index, 1);
  }
  
  systemCache.worktimeSettings.lastUpdated = new Date();
  await showWorktimeSettings(ctx, true);
});

// 6. Выбрать все дни
bot.action('admin_worktime_all_days', async (ctx) => {
  await ctx.answerCbQuery();
  if (!systemCache.worktimeSettings) return;
  
  systemCache.worktimeSettings.workDays = [0, 1, 2, 3, 4, 5, 6];
  systemCache.worktimeSettings.lastUpdated = new Date();
  
  addToSystemLog(`Админ ${ctx.from.id} установил все дни как рабочие`, 'ADMIN_ACTION');
  await showWorktimeSettings(ctx, true);
});

// 7. Настройки уведомлений
bot.action('admin_worktime_notifications', async (ctx) => {
  await ctx.answerCbQuery();
  
  if (!systemCache.worktimeSettings) return;
  
  // Переключаем все уведомления
  const current = systemCache.worktimeSettings.notifications;
  const newState = !(current.autoReply && current.offlineMessage && current.weekendMessage);
  
  systemCache.worktimeSettings.notifications = {
    autoReply: newState,
    offlineMessage: newState,
    weekendMessage: newState
  };
  
  systemCache.worktimeSettings.lastUpdated = new Date();
  
  const status = newState ? 'включил' : 'выключил';
  addToSystemLog(`Админ ${ctx.from.id} ${status} все уведомления рабочего времени`, 'ADMIN_ACTION');
  
  await showWorktimeSettings(ctx, true);
});

// 8. Тестирование рабочего времени
bot.action('admin_worktime_test', async (ctx) => {
  await ctx.answerCbQuery('⏰ Тестирую...');
  
  const now = new Date();
  const isWorkTime = checkIsWorkTime();
  
  await ctx.reply(
    `⏰ <b>ТЕСТ РАБОЧЕГО ВРЕМЕНИ</b>\n\n` +
    `📅 <b>Текущее время:</b> ${now.toLocaleString('ru-RU')}\n` +
    `🌐 <b>Часовой пояс:</b> ${systemCache.worktimeSettings?.timezone || 'Asia/Almaty'}\n` +
    `📊 <b>Статус режима:</b> ${systemCache.worktimeSettings?.enabled ? '✅ Включен' : '❌ Выключен'}\n` +
    `⚡ <b>На рабочем месте:</b> ${isWorkTime ? '✅ Да' : '❌ Нет'}\n\n` +
    `📋 <b>Текущие настройки:</b>\n` +
    `• Рабочие дни: ${systemCache.worktimeSettings?.workDays?.map(d => ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'][d]).join(', ') || 'не установлены'}\n` +
    `• Время: ${systemCache.worktimeSettings?.startHour?.toString().padStart(2, '0') || '09'}:00 - ${systemCache.worktimeSettings?.endHour?.toString().padStart(2, '0') || '18'}:00\n\n` +
    `💡 <b>Рекомендация:</b> ${isWorkTime ? 
      'Сейчас рабочее время, пользователи могут ожидать быстрого ответа' :
      'Сейчас нерабочее время, включите автоответчик если это необходимо'}`
  , { parse_mode: 'HTML' });
});

// 9. Обновление настроек
bot.action('admin_worktime_refresh', async (ctx) => {
  await ctx.answerCbQuery('🔄 Обновляю...');
  await showWorktimeSettings(ctx, true);
});

// 10. Сохранение настроек
bot.action('admin_worktime_save', async (ctx) => {
  await ctx.answerCbQuery('💾 Сохраняю...');
  
  try {
    if (!systemCache.worktimeSettings) return;
    
    systemCache.worktimeSettings.lastUpdated = new Date();
    
    // Здесь можно добавить сохранение в базу данных или файл
    // Пока сохраняем только в systemCache
    
    addToSystemLog(`Админ ${ctx.from.id} сохранил настройки рабочего времени`, 'ADMIN_ACTION');
    
    await ctx.reply(
      `✅ <b>Настройки рабочего времени сохранены</b>\n\n` +
      `📅 Последнее обновление: ${systemCache.worktimeSettings.lastUpdated.toLocaleString('ru-RU')}\n` +
      `⚙️ Настройки будут применяться автоматически`
    , { parse_mode: 'HTML' });
    
    await showWorktimeSettings(ctx, true);
    
  } catch (error) {
    console.error('Ошибка при сохранении настроек рабочего времени:', error);
    await ctx.answerCbQuery('❌ Ошибка при сохранении');
  }
});


// ========== ОБРАБОТЧИКИ УПРАВЛЕНИЯ ==========

// 1. Перезапустить бота (информационная функция)
bot.action('admin_restart', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  logAdminAction('запрос на перезапуск бота', ctx.from.id);

  console.log(`👑 Админ ${ctx.from.id} запросил инструкцию по перезапуску`);
  
  // Определяем, какой скрипт, скорее всего, используется
  const isDevMode = process.env.npm_lifecycle_event === 'dev' || process.argv.join(' ').includes('nodemon'); // Простая проверка
  const mode = isDevMode ? 'Разработка (npm run dev)' : 'Продакшен (npm run start)';
  
    await ctx.editMessageText(
    '🔄 <b>ИНСТРУКЦИЯ ПО ПЕРЕЗАПУСКУ БОТА</b>\n\n' +
    
    '⚠️ <b>Внимание:</b>\n' +
    'Бот не может безопасно перезапустить себя "изнутри".\n' +
    'Используйте инструкции ниже, в зависимости от вашего окружения.\n\n' +
    
    `📁 <b>Текущий режим:</b>\n<code>${process.env.npm_lifecycle_event || 'start'}</code>\n\n` +
    
    '👨‍💻 <b>Если вы в режиме РАЗРАБОТКИ (команда: npm run dev):</b>\n' +
    '✅ Конфигурация <code>nodemon</code> настроена верно и отслеживает <code>bot.cjs</code>.\n' +
    '1. <b>Перейдите в терминал</b>, где работает бот.\n' +
    '2. <b>Введите команду:</b> <code>rs</code>\n' +
    '3. <b>Нажмите Enter.</b> Бот перезапустится мгновенно.\n\n' +
    
    '🚀 <b>Если бот в ПРОДАКШЕНЕ (команда: npm start / PM2):</b>\n' +
    '1. Подключитесь к серверу по SSH.\n' +
    '2. Перейдите в директорию проекта.\n' +
    `3. <b>Используйте команду:</b>\n` +
    '   • Для прямого запуска: <code>npm start</code> (после остановки)\n' +
    '   • Для PM2: <code>pm2 restart bot.cjs</code> или имя вашего процесса\n\n' +
    
    '📊 <b>Текущий статус процесса:</b>\n' +
    `• Путь к файлу: <code>${__filename}</code>\n` +
    `• PID процесса: ${process.pid}\n` +
    `• Время работы: ${Math.floor(process.uptime())} секунд\n` +
    `• Режим запуска: ${process.env.npm_lifecycle_event || 'node'}\n` +
    `• Платформа: ${process.platform} (Node.js ${process.version})\n\n` +
    
    '🔧 <b>Совет:</b>\n' +
    'Для продакшена настоятельно рекомендуется использовать процесс-менеджер вроде PM2 для автоматического перезапуска при падении.',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Обновить статус', 'admin_restart')],
        [Markup.button.callback('🔙 Назад в управление', 'admin_manage')]
      ])
    }
  );
});

// 2. Создать резервную копию базы данных
bot.action('admin_backup', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  console.log(`👑 Админ ${ctx.from.id} запросил создание резервной копии`);
  
  // Показываем сообщение о начале процесса
  await ctx.editMessageText(
    '💾 <b>СОЗДАНИЕ РЕЗЕРВНОЙ КОПИИ БАЗЫ ДАННЫХ</b>\n\n' +
    '🔄 Подготавливаю данные для резервного копирования...\n' +
    '⏳ Пожалуйста, подождите несколько секунд.',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Обновить статус', 'admin_backup_status')]
      ])
    }
  );
  
  // Создаем резервную копию
  const result = await createBackup(ctx);
  
  // Если функция createBackup уже отправила результат, не нужно редактировать сообщение
  // Но если произошла ошибка, createBackup уже отправила сообщение об ошибке
  if (result) {
    // Можно отредактировать первоначальное сообщение на успешное
    // Но так как мы уже отправили документ, лучше оставить как есть или обновить
    await ctx.editMessageText(
      '✅ <b>РЕЗЕРВНАЯ КОПИЯ УСПЕШНО СОЗДАНА</b>\n\n' +
      '📄 Файл с резервной копией был отправлен вам выше.\n\n' +
      '💡 <b>Советы:</b>\n' +
      '• Сохраните файл в надежном месте\n' +
      '• Регулярно создавайте резервные копии\n' +
      '• Проверяйте целостность данных',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📊 Статистика', 'admin_stats')],
          [Markup.button.callback('🔙 Назад в управление', 'admin_manage')]
        ])
      }
    );
  }
});


// 4. Очистка системного кэша (меню подтверждения)
bot.action('admin_clear_cache', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  console.log(`👑 Админ ${ctx.from.id} запросил очистку кэша`);
  
  await ctx.editMessageText(
    '🧹 <b>ОЧИСТКА СИСТЕМНОГО КЭША</b>\n\n' +
    
    '⚠️ <b>Что будет очищено:</b>\n' +
    '• Временные данные пользователей\n' +
    '• Кэшированные списки вопросов\n' +
    '• Предварительно рассчитанная статистика\n' +
    '• История действий кэша\n\n' +
    
    '✅ <b>Что НЕ будет затронуто:</b>\n' +
    '• Основная база данных MongoDB\n' +
    '• Настройки пользователей\n' +
    '• Файлы бота на диске\n\n' +
    
    '📊 <b>Текущее состояние кэша:</b>\n' +
    `• Кэш пользователей: ${systemCache.userList ? '✅ Заполнен' : '❌ Пустой'}\n` +
    `• Кэш вопросов: ${systemCache.questionList ? '✅ Заполнен' : '❌ Пустой'}\n` +
    `• Кэш статистики: ${systemCache.stats ? '✅ Заполнен' : '❌ Пустой'}\n` +
    `• Последнее обновление: ${systemCache.lastUpdated ? systemCache.lastUpdated.toLocaleTimeString('ru-RU') : 'никогда'}\n` +
    `• Записей в логе действий: ${systemCache.actionLog.length}\n\n` +
    
    '🔄 После очистки система автоматически перезагрузит данные из базы при следующем запросе.',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Подтвердить очистку', 'admin_clear_cache_confirm'),
          Markup.button.callback('❌ Отмена', 'admin_manage')
        ]
      ])
    }
  );
});

// 5. Подтверждение очистки кэша
bot.action('admin_clear_cache_confirm', async (ctx) => {
  await ctx.answerCbQuery('🧹 Очищаю кэш...');
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  const result = await clearSystemCache(ctx);
  
  if (result.success) {
    await ctx.editMessageText(
      '✅ <b>КЭШ УСПЕШНО ОЧИЩЕН</b>\n\n' +
      
      '🧹 <b>Результаты очистки:</b>\n' +
      (result.clearedItems.length > 0 
        ? result.clearedItems.map(item => `• ${item}`).join('\n')
        : '• Не было данных для очистки') + '\n\n' +
      
      '📊 <b>Текущее состояние:</b>\n' +
      `• Кэш пользователей: ${systemCache.userList ? '✅ Заполнен' : '❌ Пустой'}\n` +
      `• Кэш вопросов: ${systemCache.questionList ? '✅ Заполнен' : '❌ Пустой'}\n` +
      `• Кэш статистики: ${systemCache.stats ? '✅ Заполнен' : '❌ Пустой'}\n` +
      `• Последнее обновление: ${systemCache.lastUpdated ? systemCache.lastUpdated.toLocaleTimeString('ru-RU') : 'никогда'}\n` +
      `• Записей в логе действий: ${systemCache.actionLog.length}\n\n` +
      
      '🔄 <b>Что делать дальше:</b>\n' +
      '• Просмотрите список пользователей - данные загрузятся из БД\n' +
      '• Проверьте вопросы - кэш обновится автоматически\n' +
      '• Посмотрите статистику - она пересчитается',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('👥 Пользователи', 'admin_users')],
          [Markup.button.callback('📊 Статистика', 'admin_stats')],
          [Markup.button.callback('🔙 Назад в управление', 'admin_manage')]
        ])
      }
    );
  } else {
    await ctx.editMessageText(
      '❌ <b>ОШИБКА ПРИ ОЧИСТКЕ КЭША</b>\n\n' +
      `Произошла ошибка: <code>${result.error}</code>\n\n` +
      'Попробуйте позже или проверьте логи системы.',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Повторить попытку', 'admin_clear_cache')],
          [Markup.button.callback('🔙 Назад в управление', 'admin_manage')]
        ])
      }
    );
  }
});


// 3. Статус резервного копирования (дополнительная кнопка)
bot.action('admin_backup_status', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  // Получаем количество пользователей для отображения в статусе
  const userCount = await ctx.db.User.countDocuments({});
  
  await ctx.editMessageText(
    '💾 <b>СТАТУС РЕЗЕРВНОГО КОПИРОВАНИЯ</b>\n\n' +
    
    '📊 <b>Текущая статистика базы данных:</b>\n' +
    `• Пользователей в базе: ${userCount}\n\n` +
    
    '🔄 <b>Создать новую резервную копию:</b>\n' +
    'Нажмите кнопку ниже, чтобы создать резервную копию всех данных.',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💾 Создать резервную копию', 'admin_backup')],
        [Markup.button.callback('📊 Общая статистика', 'admin_stats')],
        [Markup.button.callback('🔙 Назад в управление', 'admin_manage')]
      ])
    }
  );
});


// ========== ОБРАБОТЧИКИ ДЛЯ ШАБЛОНОВ ОТВЕТОВ ==========

// 1. Основной обработчик для кнопки "Шаблоны ответов"
bot.action('admin_settings_templates', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  addToSystemLog(`Админ ${ctx.from.id} открыл настройки шаблонов ответов`, 'ADMIN_ACTION');
  
  await showTemplatesSettings(ctx, 1);
});

// 2. Пагинация шаблонов
bot.action(/admin_templates_page_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) return;
  
  const page = parseInt(ctx.match[1]);
  await showTemplatesSettings(ctx, page);
});

// 3. Обновление списка шаблонов
bot.action(/admin_templates_refresh_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery('🔄 Обновляю...');
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) return;
  
  const page = parseInt(ctx.match[1]);
  await showTemplatesSettings(ctx, page, true);
});

// 4. Создание нового шаблона
bot.action('admin_template_create', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) return;
  
  addToSystemLog(`Админ ${ctx.from.id} начал создание нового шаблона`, 'ADMIN_ACTION');
  
  await showTemplateCreation(ctx);
});

// 5. Управление категориями
bot.action('admin_templates_categories', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) return;
  
  addToSystemLog(`Админ ${ctx.from.id} открыл управление категориями шаблонов`, 'ADMIN_ACTION');
  
  await showTemplateCategories(ctx);
});

// 6. Экспорт шаблонов
bot.action('admin_templates_export', async (ctx) => {
  await ctx.answerCbQuery('📤 Экспортирую...');
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) return;
  
  try {
    if (!systemCache.templates || systemCache.templates.templates.length === 0) {
      await ctx.answerCbQuery('❌ Нет шаблонов для экспорта');
      return;
    }
    
    const exportData = {
      exportDate: new Date().toISOString(),
      templatesCount: systemCache.templates.templates.length,
      categoriesCount: systemCache.templates.categories.length,
      templates: systemCache.templates.templates,
      categories: systemCache.templates.categories
    };
    
    const jsonData = JSON.stringify(exportData, null, 2);
    const fileName = `templates-export-${new Date().toISOString().slice(0, 10)}.json`;
    
    await ctx.replyWithDocument({
      source: Buffer.from(jsonData, 'utf8'),
      filename: fileName
    }, {
      caption: `📤 <b>Экспорт шаблонов завершен</b>\n\n` +
               `📅 Дата экспорта: ${new Date().toLocaleString('ru-RU')}\n` +
               `📝 Шаблонов: ${systemCache.templates.templates.length}\n` +
               `📁 Категорий: ${systemCache.templates.categories.length}\n` +
               `👤 Администратор: ${ctx.from.id}`,
      parse_mode: 'HTML'
    });
    
    addToSystemLog(`Админ ${ctx.from.id} экспортировал ${systemCache.templates.templates.length} шаблонов`, 'ADMIN_ACTION');
    
  } catch (error) {
    console.error('Ошибка при экспорте шаблонов:', error);
    await ctx.answerCbQuery('❌ Ошибка при экспорте');
  }
});

// 7. Добавление категории
bot.action('admin_category_add', async (ctx) => {
  await ctx.answerCbQuery('➕ Добавляю категорию...');
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) return;
  
  await ctx.reply(
    '📁 <b>ДОБАВЛЕНИЕ НОВОЙ КАТЕГОРИИ</b>\n\n' +
    'Введите название новой категории (например: "уход", "проблемы", "инструкции"):\n\n' +
    '❌ Для отмены отправьте "отмена"',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Назад к категориям', 'admin_templates_categories')]
      ])
    }
  );
  
  // Устанавливаем состояние ожидания категории
  await ctx.db.User.updateOne(
    { telegramId: ctx.from.id },
    { $set: { stage: 'awaiting_category_add' } }
  );
});

// 8. Статистика категорий
bot.action('admin_categories_stats', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) return;
  
  if (!systemCache.templates) {
    await ctx.answerCbQuery('❌ Нет данных о шаблонах');
    return;
  }
  
  const categories = systemCache.templates.categories;
  const templates = systemCache.templates.templates;
  
  if (categories.length === 0) {
    await ctx.reply('📊 <b>Статистика категорий</b>\n\nНет созданных категорий.', { parse_mode: 'HTML' });
    return;
  }
  
  let message = '📊 <b>СТАТИСТИКА КАТЕГОРИЙ</b>\n\n';
  
  categories.forEach(cat => {
    const categoryTemplates = templates.filter(t => t.category === cat);
    const usageCount = categoryTemplates.reduce((sum, t) => sum + t.usageCount, 0);
    
    message += `<b>📁 ${cat}:</b>\n`;
    message += `• Шаблонов: ${categoryTemplates.length}\n`;
    message += `• Использовано: ${usageCount} раз\n`;
    message += `• Последнее обновление: ${categoryTemplates.length > 0 ? 
      new Date(Math.max(...categoryTemplates.map(t => t.updatedAt))).toLocaleDateString('ru-RU') : 
      'нет данных'}\n`;
    message += `────────────────────\n`;
  });
  
  message += `\n📈 <b>Общая статистика:</b>\n`;
  message += `• Всего категорий: ${categories.length}\n`;
  message += `• Всего шаблонов: ${templates.length}\n`;
  message += `• Всего использований: ${templates.reduce((sum, t) => sum + t.usageCount, 0)}\n`;
  message += `• Самая популярная категория: ${getMostPopularCategory()}\n`;
  
  await ctx.reply(message, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Назад к категориям', 'admin_templates_categories')]
    ])
  });
});

// 9. Обновление категорий
bot.action('admin_categories_refresh', async (ctx) => {
  await ctx.answerCbQuery('🔄 Обновляю...');
  await showTemplateCategories(ctx);
});

// Вспомогательная функция для определения самой популярной категории
function getMostPopularCategory() {
  if (!systemCache.templates || !systemCache.templates.templates.length) {
    return 'нет данных';
  }
  
  const categoryUsage = {};
  systemCache.templates.templates.forEach(template => {
    if (!categoryUsage[template.category]) {
      categoryUsage[template.category] = 0;
    }
    categoryUsage[template.category] += template.usageCount;
  });
  
  let maxCategory = '';
  let maxUsage = 0;
  
  Object.entries(categoryUsage).forEach(([category, usage]) => {
    if (usage > maxUsage) {
      maxUsage = usage;
      maxCategory = category;
    }
  });
  
  return maxCategory ? `${maxCategory} (${maxUsage} использований)` : 'нет данных';
}



// ========== ГРАФИКИ АНАЛИТИКИ ==========
// Обработчики для графиков
// ========== ОБРАБОТЧИКИ ГРАФИКА ЕЖЕДНЕВНОЙ АКТИВНОСТИ ==========

// Основной обработчик графика активности
bot.action('chart_daily_activity', async (ctx) => {
  await ctx.answerCbQuery();
  await showDailyActivityChart(ctx, '7days');
});

// Обработчики для разных периодов активности
bot.action('chart_daily_7days', async (ctx) => {
  await ctx.answerCbQuery();
  await showDailyActivityChart(ctx, '7days');
});

bot.action('chart_daily_30days', async (ctx) => {
  await ctx.answerCbQuery();
  await showDailyActivityChart(ctx, '30days');
});

bot.action('chart_daily_90days', async (ctx) => {
  await ctx.answerCbQuery();
  await showDailyActivityChart(ctx, '90days');
});

// Обновление графика активности
bot.action(/chart_daily_refresh_(\w+)/, async (ctx) => {
  await ctx.answerCbQuery('🔄 Обновляю график активности...');
  const period = ctx.match[1];
  await showDailyActivityChart(ctx, period, true);
});

// График роста пользователей
bot.action('chart_users_growth', async (ctx) => {
  await ctx.answerCbQuery();
  await showUsersGrowthChart(ctx, '7days');
});

// Разные периоды для графика роста
bot.action('chart_users_7days', async (ctx) => {
  await ctx.answerCbQuery();
  await showUsersGrowthChart(ctx, '7days');
});

bot.action('chart_users_30days', async (ctx) => {
  await ctx.answerCbQuery();
  await showUsersGrowthChart(ctx, '30days');
});

bot.action('chart_users_90days', async (ctx) => {
  await ctx.answerCbQuery();
  await showUsersGrowthChart(ctx, '90days');
});

// Обновление для каждого периода
bot.action(/chart_users_refresh_(\w+)/, async (ctx) => {
  await ctx.answerCbQuery('🔄 Обновляю...');
  const period = ctx.match[1];
  await showUsersGrowthChart(ctx, period, true);
});

// Другие графики (заглушки, которые можно развить)
bot.action('chart_daily_activity', async (ctx) => {
  await ctx.answerCbQuery('📅 Этот график пока в разработке');
  // Здесь можно добавить функцию showDailyActivityChart
});

bot.action('chart_questions', async (ctx) => {
  await ctx.answerCbQuery('❓ Этот график пока в разработке');
  // Здесь можно добавить функцию showQuestionsChart
});

bot.action('chart_tattoo_dates', async (ctx) => {
  await ctx.answerCbQuery('🎨 Этот график пока в разработке');
  // Здесь можно добавить функцию showTattooDatesChart
});

bot.action('chart_hourly_activity', async (ctx) => {
  await ctx.answerCbQuery('📱 Этот график пока в разработке');
  // Здесь можно добавить функцию showHourlyActivityChart
});

bot.action('chart_summary', async (ctx) => {
  await ctx.answerCbQuery('📊 Этот график пока в разработке');
  // Здесь можно добавить функцию showSummaryChart
});

// Обновление графиков
bot.action('admin_charts_refresh', async (ctx) => {
  await ctx.answerCbQuery('🔄 Обновляю...');
  await showChartsMenu(ctx, true);
});


// Обработчик для графиков аналитики
bot.action('admin_charts', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  addToSystemLog(`Админ ${ctx.from.id} открыл графики аналитики`, 'ADMIN_ACTION');
  
  await showChartsMenu(ctx);
});

// Заглушки для остальных кнопок админки (можно развивать дальше)
bot.action(['admin_settings_limits'], async (ctx) => {
  await ctx.answerCbQuery('⏳ Этот функционал в разработке');
});

// 6. Просмотр системных логов (все)
bot.action('admin_logs', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  await showSystemLogs(ctx, 1, 'all');
});

// 7. Фильтры логов
bot.action('admin_logs_all', async (ctx) => {
  await ctx.answerCbQuery();
  await showSystemLogs(ctx, 1, 'all');
});

bot.action('admin_logs_error', async (ctx) => {
  await ctx.answerCbQuery();
  await showSystemLogs(ctx, 1, 'ERROR');
});

bot.action('admin_logs_admin', async (ctx) => {
  await ctx.answerCbQuery();
  await showSystemLogs(ctx, 1, 'ADMIN_ACTION');
});

// 8. Пагинация логов
bot.action(/admin_logs_page_(\d+)_(\w+)/, async (ctx) => {
  await ctx.answerCbQuery();
  
  const page = parseInt(ctx.match[1]);
  const logType = ctx.match[2];
  await showSystemLogs(ctx, page, logType);
});

// 9. Обновление логов
bot.action(/admin_logs_refresh_(\d+)_(\w+)/, async (ctx) => {
  await ctx.answerCbQuery('🔄 Обновляю логи...');
  
  const page = parseInt(ctx.match[1]);
  const logType = ctx.match[2];
  await showSystemLogs(ctx, page, logType, true);
});

// 10. Подтверждение очистки логов
bot.action('admin_logs_clear_confirm', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  await ctx.editMessageText(
    '⚠️ <b>ПОДТВЕРЖДЕНИЕ ОЧИСТКИ ЛОГОВ</b>\n\n' +
    
    'Вы собираетесь удалить все системные логи.\n\n' +
    
    '📊 <b>Текущая статистика:</b>\n' +
    `• Всего записей: ${systemCache.systemLogs.length}\n` +
    `• Логов действий: ${systemCache.actionLog.length}\n\n` +
    
    '🚫 <b>Это действие нельзя отменить!</b>\n' +
    'Все логи будут безвозвратно удалены.\n\n' +
    
    '✅ Новые логи начнут записываться с этого момента.',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Да, очистить все логи', 'admin_logs_clear'),
          Markup.button.callback('❌ Нет, отмена', 'admin_logs')
        ]
      ])
    }
  );
});

// 11. Очистка логов
bot.action('admin_logs_clear', async (ctx) => {
  await ctx.answerCbQuery('🧹 Очищаю логи...');
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  const logsCount = systemCache.systemLogs.length;
  const actionLogsCount = systemCache.actionLog.length;
  
  // Очищаем логи
  systemCache.systemLogs = [];
  systemCache.actionLog = [];
  
  // Логируем действие очистки
  addToSystemLog(`Админ ${ctx.from.id} очистил все логи (удалено: ${logsCount} системных, ${actionLogsCount} действий)`, 'ADMIN_ACTION');
  
  await ctx.editMessageText(
    '✅ <b>ЛОГИ УСПЕШНО ОЧИЩЕНЫ</b>\n\n' +
    
    '🧹 <b>Результаты очистки:</b>\n' +
    `• Удалено системных логов: ${logsCount}\n` +
    `• Удалено логов действий: ${actionLogsCount}\n` +
    `• Всего удалено записей: ${logsCount + actionLogsCount}\n\n` +
    
    '🕒 <b>Время очистки:</b> ' + new Date().toLocaleTimeString('ru-RU') + '\n\n' +
    
    '📝 Новые логи будут записываться с этого момента.',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📋 Перейти к логам', 'admin_logs')],
        [Markup.button.callback('🔙 Назад в управление', 'admin_manage')]
      ])
    }
  );
});

// 11. Проверка производительности системы
bot.action('admin_performance', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  await showPerformance(ctx, false);
});

// 12. Обновление производительности
bot.action('admin_performance_refresh', async (ctx) => {
  await ctx.answerCbQuery('🔄 Обновляю статистику...');
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  await showPerformance(ctx, true);
});

// 12. Настройки базы данных
bot.action('admin_db_settings', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  await showDBSettings(ctx, false);
});

// 13. Обновление настроек БД
bot.action('admin_db_settings_refresh', async (ctx) => {
  await ctx.answerCbQuery('🔄 Обновляю информацию о БД...');
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  await showDBSettings(ctx, true);
});

// 14. Меню рассылки
bot.action('admin_broadcast', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  addToSystemLog(`Админ ${ctx.from.id} открыл меню рассылки`, 'ADMIN_ACTION');
  
  await ctx.editMessageText(
    '📢 <b>РАССЫЛКА СООБЩЕНИЙ</b>\n\n' +
    
    '⚠️ <b>Внимание:</b>\n' +
    'Рассылка отправляется всем пользователям бота.\n' +
    'Используйте эту функцию осторожно.\n\n' +
    
    '📊 <b>Статистика:</b>\n' +
    `• Активных пользователей: ${await ctx.db.User.countDocuments({}) || 0}\n` +
    `• Последняя рассылка: ${broadcastState.endTime ? broadcastState.endTime.toLocaleString('ru-RU') : 'никогда'}\n\n` +
    
    '🎯 <b>Выберите тип рассылки:</b>',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('📝 Всем пользователям', 'admin_broadcast_all'),
          Markup.button.callback('🎯 С датой тату', 'admin_broadcast_tattoo')
        ],
        [
          Markup.button.callback('❓ С вопросами', 'admin_broadcast_questions'),
          Markup.button.callback('📅 Активным (7 дней)', 'admin_broadcast_active')
        ],
        [
          Markup.button.callback('📊 Статистика рассылок', 'admin_broadcast_stats'),
          Markup.button.callback('🔙 Назад', 'admin_back')
        ]
      ])
    }
  );
});

// 15. Рассылка всем пользователям (начало)
bot.action('admin_broadcast_all', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  addToSystemLog(`Админ ${ctx.from.id} выбрал рассылку всем пользователям`, 'ADMIN_ACTION');
  
  // Проверяем, не выполняется ли уже рассылка
  if (broadcastState.isActive) {
    await ctx.answerCbQuery('⚠️ Уже выполняется другая рассылка');
    
    await ctx.editMessageText(
      '⚠️ <b>РАССЫЛКА УЖЕ ВЫПОЛНЯЕТСЯ</b>\n\n' +
      
      'Другая рассылка уже выполняется. Дождитесь её завершения.\n\n' +
      
      '📊 <b>Текущий статус:</b>\n' +
      `• Администратор: ${broadcastState.currentAdminId}\n` +
      `• Успешно отправлено: ${broadcastState.successCount}\n` +
      `• Не удалось: ${broadcastState.failedCount}\n` +
      `• Всего получателей: ${broadcastState.totalUsers}\n\n` +
      
      '⏱️ <b>Время начала:</b> ' + (broadcastState.startTime ? broadcastState.startTime.toLocaleTimeString('ru-RU') : 'неизвестно'),
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Проверить статус', 'admin_broadcast_status')],
          [Markup.button.callback('🔙 Назад', 'admin_broadcast')]
        ])
      }
    );
    return;
  }
  
  // Запрашиваем текст рассылки
  await ctx.editMessageText(
    '📝 <b>РАССЫЛКА ВСЕМ ПОЛЬЗОВАТЕЛЯМ</b>\n\n' +
    
    '✍️ <b>Введите текст для рассылки:</b>\n\n' +
    
    '💡 <b>Можно использовать HTML-разметку:</b>\n' +
    '• <code>&lt;b&gt;жирный текст&lt;/b&gt;</code>\n' +
    '• <code>&lt;i&gt;курсив&lt;/i&gt;</code>\n' +
    '• <code>&lt;code&gt;код&lt;/code&gt;</code>\n' +
    '• <code>&lt;a href="URL"&gt;ссылка&lt;/a&gt;</code>\n\n' +
    
    '⚠️ <b>Предупреждение:</b>\n' +
    '• Не злоупотребляйте рассылками\n' +
    '• Проверяйте текст перед отправкой\n' +
    '• Рассылка может занять несколько минут\n\n' +
    
    '❌ <b>Для отмены введите "отмена"</b>',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Назад в меню рассылки', 'admin_broadcast')]
      ])
    }
  );
  
  // Устанавливаем состояние ожидания текста
  await ctx.db.User.updateOne(
    { telegramId: ctx.from.id },
    { $set: { stage: 'awaiting_broadcast_text', broadcastType: 'all' } }
  );
});
// 18. Рассылка пользователям с датой тату (начало)
bot.action('admin_broadcast_tattoo', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  addToSystemLog(`Админ ${ctx.from.id} выбрал рассылку пользователям с датой тату`, 'ADMIN_ACTION');
  
  // Проверяем, не выполняется ли уже рассылка
  if (broadcastState.isActive) {
    await ctx.answerCbQuery('⚠️ Уже выполняется другая рассылка');
    
    await ctx.editMessageText(
      '⚠️ <b>РАССЫЛКА УЖЕ ВЫПОЛНЯЕТСЯ</b>\n\n' +
      
      'Другая рассылка уже выполняется. Дождитесь её завершения.\n\n' +
      
      '📊 <b>Текущий статус:</b>\n' +
      `• Администратор: ${broadcastState.currentAdminId}\n` +
      `• Тип: ${broadcastState.messageText ? 'Активная рассылка' : 'Неизвестно'}\n` +
      `• Успешно отправлено: ${broadcastState.successCount}\n` +
      `• Не удалось: ${broadcastState.failedCount}\n\n` +
      
      '⏱️ <b>Время начала:</b> ' + (broadcastState.startTime ? broadcastState.startTime.toLocaleTimeString('ru-RU') : 'неизвестно'),
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Проверить статус', 'admin_broadcast_status')],
          [Markup.button.callback('🔙 Назад', 'admin_broadcast')]
        ])
      }
    );
    return;
  }
  
  // Получаем статистику перед началом
  const totalUsers = await ctx.db.User.countDocuments({});
  const tattooUsers = await ctx.db.User.countDocuments({ 
    tattooDate: { $ne: null, $exists: true } 
  });
  const percentage = totalUsers > 0 ? Math.round((tattooUsers / totalUsers) * 100) : 0;
  
  // Запрашиваем текст рассылки
  await ctx.editMessageText(
    `🎯 <b>РАССЫЛКА ПОЛЬЗОВАТЕЛЯМ С ДАТОЙ ТАТУ</b>\n\n` +
    
    `📊 <b>Статистика аудитории:</b>\n` +
    `• Всего пользователей: ${totalUsers}\n` +
    `• С датой татуировки: ${tattooUsers} (${percentage}%)\n` +
    `• Без даты тату: ${totalUsers - tattooUsers}\n\n` +
    
    `✍️ <b>Введите текст для рассылки:</b>\n\n` +
    `   Тут вы можете написать текст рассылки.\n\n` +
    
    `💡 <b>Особенности этой рассылки:</b>\n` +
    `• Сообщение получит ${tattooUsers} пользователей\n` +
    `• Можно добавить персонализацию\n` +
    `• Уместно говорить о уходе, коррекции и т.д.\n\n` +
    
    `🎨 <b>Пример тематики:</b>\n` +
    `"Уход за татуировкой", "Коррекция", "Сезонные рекомендации"\n\n` +
    
    `⚠️ <b>Предупреждение:</b>\n` +
    `• Сообщение должно быть релевантным\n` +
    `• Не спамите этой аудитории\n` +
    `• Проверяйте текст перед отправкой\n\n` +
    
    `❌ <b>Для отмены введите "отмена"</b>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Назад в меню рассылки', 'admin_broadcast')]
      ])
    }
  );
  
  // Устанавливаем состояние ожидания текста для рассылки тату
  await ctx.db.User.updateOne(
    { telegramId: ctx.from.id },
    { $set: { stage: 'awaiting_broadcast_tattoo_text' } }
  );
});

// Обработчик для кнопки "С вопросами" в меню рассылки - ИСПРАВЛЕННЫЙ ВАРИАНТ
bot.action('admin_broadcast_questions', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  addToSystemLog(`Админ ${ctx.from.id} выбрал рассылку пользователям с вопросами`, 'ADMIN_ACTION');
  
  // Проверяем, не выполняется ли уже рассылка
  if (broadcastState.isActive) {
    await ctx.answerCbQuery('⚠️ Уже выполняется другая рассылка');
    
    await ctx.editMessageText(
      '⚠️ <b>РАССЫЛКА УЖЕ ВЫПОЛНЯЕТСЯ</b>\n\n' +
      
      'Другая рассылка уже выполняется. Дождитесь её завершения.\n\n' +
      
      '📊 <b>Текущий статус:</b>\n' +
      `• Администратор: ${broadcastState.currentAdminId}\n` +
      `• Успешно отправлено: ${broadcastState.successCount}\n` +
      `• Не удалось: ${broadcastState.failedCount}\n` +
      `• Всего получателей: ${broadcastState.totalUsers}\n\n` +
      
      '⏱️ <b>Время начала:</b> ' + (broadcastState.startTime ? broadcastState.startTime.toLocaleTimeString('ru-RU') : 'неизвестно'),
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Проверить статус', 'admin_broadcast_status')],
          [Markup.button.callback('🔙 Назад', 'admin_broadcast')]
        ])
      }
    );
    return;
  }
  
  // Получаем статистику перед началом
  const totalUsers = await ctx.db.User.countDocuments({});
  const usersWithQuestions = await ctx.db.User.countDocuments({ 
    questions: { $exists: true, $ne: [] }
  });
  
  // Считаем общее количество вопросов
  const allUsers = await ctx.db.User.find({ 'questions.0': { $exists: true } });
  let totalQuestions = 0;
  let pendingQuestions = 0;
  
  allUsers.forEach(user => {
    if (user.questions && Array.isArray(user.questions)) {
      totalQuestions += user.questions.length;
      pendingQuestions += user.questions.filter(q => q.status === 'pending').length;
    }
  });
  
  const percentage = totalUsers > 0 ? Math.round((usersWithQuestions / totalUsers) * 100) : 0;
  
  // Запрашиваем текст рассылки
  await ctx.editMessageText(
    `❓ <b>РАССЫЛКА ПОЛЬЗОВАТЕЛЯМ С ВОПРОСАМИ</b>\n\n` +
    
    `📊 <b>Статистика аудитории:</b>\n` +
    `• Всего пользователей: ${totalUsers}\n` +
    `• Задавали вопросы: ${usersWithQuestions} (${percentage}%)\n` +
    `• Всего задано вопросов: ${totalQuestions}\n` +
    `• Ожидают ответа: ${pendingQuestions}\n\n` +
    
    `✍️ <b>Введите текст для рассылки:</b>\n\n` +
    
    `💡 <b>Особенности этой рассылки:</b>\n` +
    `• Сообщение получит ${usersWithQuestions} пользователей\n` +
    `• Это активные пользователи, интересующиеся уходом\n` +
    `• Можно упомянуть, что их вопросы важны для нас\n\n` +
    
    `📚 <b>Пример тематики:</b>\n` +
    `"Ответы на частые вопросы", "Новые функции бота", "Обновление базы знаний"\n\n` +
    
    `⚠️ <b>Предупреждение:</b>\n` +
    `• Будьте вежливы и благодарны\n` +
    `• Напомните о возможности задать новые вопросы\n` +
    `• Проверяйте текст перед отправкой\n\n` +
    
    `❌ <b>Для отмены введите "отмена"</b>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Назад в меню рассылки', 'admin_broadcast')]
      ])
    }
  );
  
  // Устанавливаем состояние ожидания текста для рассылки вопросами
  await ctx.db.User.updateOne(
    { telegramId: ctx.from.id },
    { $set: { stage: 'awaiting_broadcast_questions_text' } }
  );
});

// 16. Статус рассылки
bot.action('admin_broadcast_status', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  if (!broadcastState.isActive && !broadcastState.endTime) {
    await ctx.editMessageText(
      'ℹ️ <b>НЕТ АКТИВНЫХ РАССЫЛОК</b>\n\n' +
      'В данный момент нет выполняющихся рассылок.',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📝 Начать рассылку', 'admin_broadcast_all')],
          [Markup.button.callback('🔙 Назад', 'admin_broadcast')]
        ])
      }
    );
    return;
  }
  
  if (broadcastState.isActive) {
    const progress = Math.round((broadcastState.successCount + broadcastState.failedCount) / broadcastState.totalUsers * 100);
    const elapsed = Math.floor((new Date() - broadcastState.startTime) / 1000);
    
    await ctx.editMessageText(
      '🔄 <b>РАССЫЛКА В ПРОЦЕССЕ</b>\n\n' +
      `📊 <b>Прогресс:</b> ${progress}%\n` +
      `✅ <b>Успешно:</b> ${broadcastState.successCount}\n` +
      `❌ <b>Не удалось:</b> ${broadcastState.failedCount}\n` +
      `👥 <b>Всего получателей:</b> ${broadcastState.totalUsers}\n` +
      `⏱️ <b>Прошло времени:</b> ${elapsed} сек\n\n` +
      `📝 <b>Сообщение:</b>\n${broadcastState.messageText ? broadcastState.messageText.substring(0, 100) + (broadcastState.messageText.length > 100 ? '...' : '') : 'не указано'}`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Обновить статус', 'admin_broadcast_status')],
          [Markup.button.callback('⏹️ Прервать рассылку', 'admin_broadcast_cancel')]
        ])
      }
    );
  } else {
    const totalTime = Math.floor((broadcastState.endTime - broadcastState.startTime) / 1000);
    const successRate = Math.round((broadcastState.successCount / broadcastState.totalUsers) * 100);
    
    await ctx.editMessageText(
      '✅ <b>ПОСЛЕДНЯЯ РАССЫЛКА</b>\n\n' +
      `📊 <b>Результаты:</b>\n` +
      `• Всего получателей: ${broadcastState.totalUsers}\n` +
      `• Успешно отправлено: ${broadcastState.successCount}\n` +
      `• Не удалось отправить: ${broadcastState.failedCount}\n` +
      `• Процент успеха: ${successRate}%\n\n` +
      `⏱️ <b>Время:</b>\n` +
      `• Начало: ${broadcastState.startTime.toLocaleTimeString('ru-RU')}\n` +
      `• Завершение: ${broadcastState.endTime.toLocaleTimeString('ru-RU')}\n` +
      `• Общее время: ${totalTime} секунд\n\n` +
      `📝 <b>Сообщение:</b>\n${broadcastState.messageText ? broadcastState.messageText.substring(0, 150) + (broadcastState.messageText.length > 150 ? '...' : '') : 'не указано'}`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📝 Новая рассылка', 'admin_broadcast_all')],
          [Markup.button.callback('🔙 Назад', 'admin_broadcast')]
        ])
      }
    );
  }
});

// 17. Отмена рассылки
bot.action('admin_broadcast_cancel', async (ctx) => {
  await ctx.answerCbQuery('⏹️ Прерываю рассылку...');
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  if (!broadcastState.isActive) {
    await ctx.answerCbQuery('ℹ️ Нет активных рассылок для отмены');
    return;
  }
  
  broadcastState.isActive = false;
  
  await ctx.editMessageText(
    '⏹️ <b>РАССЫЛКА ПРЕРВАНА</b>\n\n' +
    `Администратор прервал рассылку.\n\n` +
    `📊 <b>Частичные результаты:</b>\n` +
    `• Успешно отправлено: ${broadcastState.successCount}\n` +
    `• Не удалось: ${broadcastState.failedCount}\n` +
    `• Всего должно было быть: ${broadcastState.totalUsers}\n\n` +
    `⏱️ <b>Время работы:</b> ${Math.floor((new Date() - broadcastState.startTime) / 1000)} секунд`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📝 Новая рассылка', 'admin_broadcast_all')],
        [Markup.button.callback('🔙 Назад', 'admin_broadcast')]
      ])
    }
  );
  
  addToSystemLog(`Админ ${ctx.from.id} прервал рассылку. Отправлено: ${broadcastState.successCount} из ${broadcastState.totalUsers}`, 'ADMIN_ACTION');
});


// Функция для рассылки пользователям, которые задавали вопросы
async function startBroadcastToUsersWithQuestions(ctx, messageText) {
  try {
    const ADMIN_ID = 1427347068;
    if (ctx.from.id !== ADMIN_ID) {
      return false;
    }

    console.log(`❓ Админ ${ctx.from.id} начинает рассылку пользователям с вопросами`);

    // Сбрасываем состояние
    broadcastState.isActive = true;
    broadcastState.currentAdminId = ctx.from.id;
    broadcastState.messageText = messageText;
    broadcastState.totalUsers = 0;
    broadcastState.successCount = 0;
    broadcastState.failedCount = 0;
    broadcastState.startTime = new Date();

    // Получаем пользователей с вопросами
    const users = await ctx.db.User.find({ 
      questions: { $exists: true, $ne: [] }
    });
    broadcastState.totalUsers = users.length;

    // Получаем статистику
    const totalUsers = await ctx.db.User.countDocuments({});
    const usersWithQuestionsPercentage = totalUsers > 0 ? Math.round((users.length / totalUsers) * 100) : 0;

    // Если нет пользователей с вопросами
    if (users.length === 0) {
      broadcastState.isActive = false;
      await ctx.reply('❌ <b>Нет пользователей с вопросами</b>\n\n' +
        'В базе данных нет пользователей, которые задавали вопросы.\n\n' +
        '📊 <b>Статистика:</b>\n' +
        `• Всего пользователей: ${totalUsers}\n` +
        `• С вопросами: ${users.length} (${usersWithQuestionsPercentage}%)\n\n` +
        '💡 <b>Совет:</b> Пользователи могут задать вопрос через меню "❓ Задать вопрос"',
        { parse_mode: 'HTML' });
      return false;
    }

    // Подсчитываем статистику по вопросам
    let totalQuestions = 0;
    let pendingQuestions = 0;
    let answeredQuestions = 0;
    
    users.forEach(user => {
      if (user.questions && Array.isArray(user.questions)) {
        totalQuestions += user.questions.length;
        user.questions.forEach(q => {
          if (q.status === 'pending') pendingQuestions++;
          if (q.status === 'answered') answeredQuestions++;
        });
      }
    });

    // Отправляем сообщение о начале рассылки
    const startMessage = await ctx.replyWithHTML(
      `❓ <b>РАССЫЛКА ПОЛЬЗОВАТЕЛЯМ С ВОПРОСАМИ</b>\n\n` +
      `📝 <b>Сообщение:</b>\n${messageText.substring(0, 200)}${messageText.length > 200 ? '...' : ''}\n\n` +
      `📊 <b>Статистика аудитории:</b>\n` +
      `• Всего пользователей: ${totalUsers}\n` +
      `• Задавали вопросы: ${users.length} (${usersWithQuestionsPercentage}%)\n` +
      `• Всего вопросов: ${totalQuestions}\n` +
      `• Ожидают ответа: ${pendingQuestions}\n` +
      `• Отвечено: ${answeredQuestions}\n\n` +
      `⏱️ <b>Начало:</b> ${broadcastState.startTime.toLocaleTimeString('ru-RU')}\n\n` +
      `🔄 <b>Рассылка началась...</b>`
    );

    let progressMessageId = startMessage.message_id;

    // Функция обновления прогресса
    const updateProgress = async () => {
      if (!broadcastState.isActive) return;

      const progress = Math.round((broadcastState.successCount + broadcastState.failedCount) / broadcastState.totalUsers * 100);
      const elapsed = Math.floor((new Date() - broadcastState.startTime) / 1000);
      const remaining = users.length - (broadcastState.successCount + broadcastState.failedCount);

      try {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          progressMessageId,
          null,
          `❓ <b>РАССЫЛКА ПОЛЬЗОВАТЕЛЯМ С ВОПРОСАМИ</b>\n\n` +
          `📝 <b>Сообщение:</b>\n${broadcastState.messageText.substring(0, 120)}${broadcastState.messageText.length > 120 ? '...' : ''}\n\n` +
          `📊 <b>Прогресс:</b> ${progress}%\n` +
          `✅ <b>Успешно:</b> ${broadcastState.successCount}\n` +
          `❌ <b>Не удалось:</b> ${broadcastState.failedCount}\n` +
          `❓ <b>С вопросами:</b> ${users.length}\n` +
          `⏱️ <b>Прошло времени:</b> ${elapsed} сек\n` +
          `📋 <b>Осталось:</b> ${remaining}\n\n` +
          `🔄 <b>Рассылка продолжается...</b>`,
          { parse_mode: 'HTML' }
        );
      } catch (error) {
        console.error('Ошибка при обновлении прогресса рассылки вопросами:', error);
      }
    };

    // Отправляем сообщения пользователям
    for (let i = 0; i < users.length; i++) {
      if (!broadcastState.isActive) break;

      const user = users[i];
      
      try {
        // Пропускаем администратора, если это не нужно
        if (user.telegramId === ADMIN_ID) {
          broadcastState.successCount++;
          continue;
        }

        // Добавляем информацию о вопросах пользователя
        let questionsInfo = '';
        if (user.questions && user.questions.length > 0) {
          const pendingCount = user.questions.filter(q => q.status === 'pending').length;
          const answeredCount = user.questions.filter(q => q.status === 'answered').length;
          questionsInfo = `\n\n❓ <b>Ваши вопросы:</b> ${user.questions.length}\n` +
                         `⏳ Ожидают ответа: ${pendingCount}\n` +
                         `✅ Отвечено: ${answeredCount}`;
        }

        await ctx.telegram.sendMessage(
          user.telegramId,
          `❓ <b>СООБЩЕНИЕ ДЛЯ ПОЛЬЗОВАТЕЛЕЙ С ВОПРОСАМИ</b>\n\n` +
          `${messageText}\n` +
          `${questionsInfo}\n\n` +
          `— Администрация бота`,
          { parse_mode: 'HTML' }
        );
        
        broadcastState.successCount++;
        
        // Обновляем прогресс каждые 5 отправок
        if (i % 5 === 0 || i === users.length - 1) {
          await updateProgress();
        }
        
        // Задержка между сообщениями
        await new Promise(resolve => setTimeout(resolve, 150));
        
      } catch (error) {
        console.error(`Ошибка отправки пользователю с вопросами ${user.telegramId}:`, error.message);
        broadcastState.failedCount++;
        
        // Если пользователь заблокировал бота, удаляем его из БД
        if (error.response && error.response.error_code === 403) {
          try {
            await ctx.db.User.deleteOne({ telegramId: user.telegramId });
            console.log(`Пользователь с вопросами ${user.telegramId} заблокировал бота, удален из БД`);
          } catch (deleteError) {
            console.error('Ошибка при удалении пользователя с вопросами:', deleteError);
          }
        }
      }
    }

    // Завершение рассылки
    broadcastState.endTime = new Date();
    broadcastState.isActive = false;
    
    const totalTime = Math.floor((broadcastState.endTime - broadcastState.startTime) / 1000);
    const successRate = Math.round((broadcastState.successCount / broadcastState.totalUsers) * 100);

    // Финальное сообщение
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      progressMessageId,
      null,
      `✅ <b>РАССЫЛКА ЗАВЕРШЕНА</b>\n\n` +
      `❓ <b>Целевая аудитория:</b> Пользователи с вопросами\n\n` +
      `📊 <b>Результаты:</b>\n` +
      `• Всего пользователей в базе: ${totalUsers}\n` +
      `• Пользователей с вопросами: ${users.length} (${usersWithQuestionsPercentage}%)\n` +
      `• Всего вопросов в системе: ${totalQuestions}\n` +
      `• Успешно отправлено: ${broadcastState.successCount}\n` +
      `• Не удалось отправить: ${broadcastState.failedCount}\n` +
      `• Процент успеха: ${successRate}%\n\n` +
      `⏱️ <b>Время:</b>\n` +
      `• Начало: ${broadcastState.startTime.toLocaleTimeString('ru-RU')}\n` +
      `• Завершение: ${broadcastState.endTime.toLocaleTimeString('ru-RU')}\n` +
      `• Общее время: ${totalTime} секунд\n\n` +
      `💡 <b>Аналитика:</b>\n` +
      `Это сегмент пользователей, которые активно интересуются уходом за татуировками.`,
      { parse_mode: 'HTML' }
    );

    console.log(`✅ Рассылка пользователям с вопросами завершена. Успешно: ${broadcastState.successCount}/${users.length}`);
    return true;

  } catch (error) {
    console.error('❌ Критическая ошибка при рассылке вопросами:', error);
    
    broadcastState.isActive = false;
    
    await ctx.reply(
      `❌ <b>ОШИБКА ПРИ РАССЫЛКЕ ПОЛЬЗОВАТЕЛЯМ С ВОПРОСАМИ</b>\n\n` +
      `Произошла критическая ошибка: ${error.message}\n\n` +
      `Рассылка прервана. Частично отправлено: ${broadcastState.successCount} сообщений.`,
      { parse_mode: 'HTML' }
    );
    
    return false;
  }
}

// ========== РАССЫЛКА АКТИВНЫМ ПОЛЬЗОВАТЕЛЯМ (7 ДНЕЙ) ==========

// 18. Рассылка активным пользователям (за последние 7 дней) - начало
bot.action('admin_broadcast_active', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  addToSystemLog(`Админ ${ctx.from.id} выбрал рассылку активным пользователям (7 дней)`, 'ADMIN_ACTION');
  
  // Проверяем, не выполняется ли уже рассылка
  if (broadcastState.isActive) {
    await ctx.answerCbQuery('⚠️ Уже выполняется другая рассылка');
    // ... (код проверки активной рассылки, аналогичный другим функциям)
    return;
  }
  
  // Запрашиваем текст рассылки
  await ctx.editMessageText(
    '📅 <b>РАССЫЛКА АКТИВНЫМ ПОЛЬЗОВАТЕЛЯМ (7 ДНЕЙ)</b>\n\n' +
    '✍️ <b>Введите текст для рассылки:</b>\n\n' +
    '💡 <b>Особенности этой рассылки:</b>\n' +
    '• Сообщение получат пользователи, активные за последние 7 дней\n' +
    '• Это наиболее вовлеченная аудитория\n\n' +
    '⚠️ <b>Предупреждение:</b>\n' +
    '• Не злоупотребляйте рассылками\n' +
    '• Проверяйте текст перед отправкой\n\n' +
    '❌ <b>Для отмены введите "отмена"</b>',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Назад в меню рассылки', 'admin_broadcast')]
      ])
    }
  );
  
  // Устанавливаем состояние ожидания текста
  await ctx.db.User.updateOne(
    { telegramId: ctx.from.id },
    { $set: { stage: 'awaiting_broadcast_active_text' } }
  );
});

// Добавьте команду /broadcast для тестирования рассылки (упрощенная версия)
bot.command('broadcast', async (ctx) => {
  const ADMIN_ID = 1427347068;
  
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply('❌ У вас нет прав администратора');
  }
  
  const message = ctx.message.text.substring('/broadcast'.length).trim();
  
  if (!message) {
    return ctx.reply('📝 Использование: /broadcast [текст сообщения]');
  }
  
  await ctx.reply('🔄 Начинаю рассылку...');
  
  try {
    const users = await ctx.db.User.find({});
    let success = 0;
    let failed = 0;
    
    for (const user of users) {
      try {
        // Отправляем сообщение пользователю
        await ctx.telegram.sendMessage(
          user.telegramId,
          `📢 <b>ВАЖНОЕ ОБЪЯВЛЕНИЕ</b>\n\n${message}\n\n— Администрация бота`,
          { parse_mode: 'HTML' }
        );
        success++;
        
        // Небольшая задержка чтобы не спамить
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        failed++;
        console.error(`Ошибка отправки пользователю ${user.telegramId}:`, error.message);
      }
    }
    
    await ctx.replyWithHTML(
      `✅ <b>Рассылка завершена!</b>\n\n` +
      `📊 <b>Результаты:</b>\n` +
      `• Успешно: ${success}\n` +
      `• Не удалось: ${failed}\n` +
      `• Всего: ${users.length}`
    );
    
  } catch (error) {
    console.error('Ошибка при рассылке:', error);
    await ctx.reply(`❌ Ошибка при рассылке: ${error.message}`);
  }
});

// ========== ОБРАБОТЧИКИ ДЛЯ УПРАВЛЕНИЯ ДОСТУПОМ ==========

// 1. Основной обработчик для кнопки "Управление доступом"
bot.action('admin_settings_access', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  addToSystemLog(`Админ ${ctx.from.id} открыл управление доступом`, 'ADMIN_ACTION');
  
  await showAccessSettings(ctx);
});

// 2. Обновление списка доступа
bot.action('admin_access_refresh', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  addToSystemLog(`Админ ${ctx.from.id} обновил список доступа`, 'ADMIN_ACTION');
  
  await showAccessSettings(ctx, true);
});

// 3. Добавление нового администратора
bot.action('admin_access_add', async (ctx) => {
  await showAddAdminDialog(ctx);
});

// 4. Показ списка для удаления администраторов
bot.action('admin_access_remove_list', async (ctx) => {
  try {
    const ADMIN_ID = 1427347068;
    if (ctx.from.id !== ADMIN_ID) return;

    // Проверяем, может ли текущий администратор удалять других
    if (!systemCache.accessSettings) {
      await ctx.answerCbQuery('❌ Настройки доступа не загружены');
      return;
    }
    
    const currentAdmin = systemCache.accessSettings.admins.find(a => a.id === ctx.from.id);
    if (!currentAdmin?.permissions?.fullAccess) {
      await ctx.answerCbQuery('❌ Только главный администратор может удалять других');
      return;
    }

    const admins = systemCache.accessSettings.admins.filter(a => !a.permissions?.fullAccess);
    
    if (admins.length === 0) {
      await ctx.answerCbQuery('❌ Нет дополнительных администраторов для удаления');
      await showAccessSettings(ctx);
      return;
    }

    let message = '🗑️ <b>УДАЛЕНИЕ АДМИНИСТРАТОРА</b>\n\n';
    message += 'Выберите администратора для удаления:\n\n';

    admins.forEach((admin, index) => {
      message += `<b>${index + 1}. ${admin.name}</b>\n`;
      message += `ID: ${admin.id}\n`;
      if (admin.username) {
        message += `@${admin.username}\n`;
      }
      message += `Добавлен: ${admin.addedAt?.toLocaleDateString('ru-RU') || 'неизвестно'}\n`;
      message += `────────────────────\n`;
    });

    message += `\n⚠️ <b>Внимание:</b> Удаление администратора отзывает все его права доступа.`;

    // Создаем кнопки для каждого администратора
    const keyboardButtons = admins.map(admin => [
      Markup.button.callback(`🗑️ ${admin.name}`, `admin_access_remove_${admin.id}`)
    ]);
    
    keyboardButtons.push([
      Markup.button.callback('🔙 Назад', 'admin_settings_access')
    ]);

    const keyboard = Markup.inlineKeyboard(keyboardButtons);

    await ctx.editMessageText(message, {
      parse_mode: 'HTML',
      ...keyboard
    });

    await ctx.answerCbQuery();

  } catch (error) {
    console.error('Ошибка при отображении списка удаления:', error);
    await ctx.answerCbQuery('❌ Ошибка');
  }
});

// 5. Удаление конкретного администратора (регулярное выражение)
bot.action(/admin_access_remove_(\d+)/, async (ctx) => {
  try {
    const ADMIN_ID = 1427347068;
    if (ctx.from.id !== ADMIN_ID) return;

    const adminIdToRemove = parseInt(ctx.match[1]);
    
    // Проверяем, может ли текущий администратор удалять других
    if (!systemCache.accessSettings) {
      await ctx.answerCbQuery('❌ Настройки доступа не загружены');
      return;
    }
    
    const currentAdmin = systemCache.accessSettings.admins.find(a => a.id === ctx.from.id);
    if (!currentAdmin?.permissions?.fullAccess) {
      await ctx.answerCbQuery('❌ Только главный администратор может удалять других');
      return;
    }

    // Нельзя удалить главного администратора или себя
    if (adminIdToRemove === ADMIN_ID) {
      await ctx.answerCbQuery('❌ Нельзя удалить главного администратора');
      return;
    }
    
    if (adminIdToRemove === ctx.from.id) {
      await ctx.answerCbQuery('❌ Нельзя удалить самого себя');
      return;
    }

    const adminToRemove = systemCache.accessSettings.admins.find(a => a.id === adminIdToRemove);
    if (!adminToRemove) {
      await ctx.answerCbQuery('❌ Администратор не найден');
      return;
    }

    // Удаляем администратора
    systemCache.accessSettings.admins = systemCache.accessSettings.admins.filter(a => a.id !== adminIdToRemove);
    systemCache.accessSettings.lastUpdated = new Date();
    // 👇 Сохраняем в БД
    try {
      await ctx.db.User.updateOne(
        { telegramId: adminIdToRemove },
        {
          $set: {
            isAdmin: false,
            adminPermissions: {
              fullAccess: false,
              canManageUsers: false,
              canManageQuestions: false,
              canManageSettings: false,
              canSendBroadcasts: false,
              canViewAnalytics: false
            }
          }
        }
      );
    } catch (dbError) {
      console.error('Ошибка при обновлении БД при удалении администратора:', dbError);
    }

    addToSystemLog(`Админ ${ctx.from.id} удалил администратора ${adminIdToRemove} (${adminToRemove.name})`, 'ADMIN_ACTION');
    
    await ctx.answerCbQuery(`✅ Администратор ${adminToRemove.name} удален`);
    await showAccessSettings(ctx, true);

  } catch (error) {
    console.error('Ошибка при удалении администратора:', error);
    await ctx.answerCbQuery('❌ Ошибка при удалении');
  }
});

// 6. Показ списка прав доступа
bot.action('admin_access_list_permissions', async (ctx) => {
  try {
    const ADMIN_ID = 1427347068;
    if (ctx.from.id !== ADMIN_ID) return;

    let message = '📋 <b>СПИСОК ПРАВ ДОСТУПА</b>\n\n';
    
    message += '👑 <b>Главный администратор:</b>\n';
    message += '• Полный доступ ко всем функциям\n';
    message += '• Управление другими администраторами\n';
    message += '• Настройка системы\n\n';
    
    message += '🔧 <b>Стандартные права:</b>\n';
    message += '• 👥 <b>Управление пользователями:</b> просмотр, управление пользователями\n';
    message += '• ❓ <b>Управление вопросами:</b> ответы на вопросы, просмотр вопросов\n';
    message += '• ⚙️ <b>Управление настройками:</b> изменение настроек бота\n';
    message += '• 📢 <b>Рассылки:</b> отправка сообщений пользователям\n';
    message += '• 📊 <b>Аналитика:</b> просмотр статистики и графиков\n\n';
    
    message += '💡 <b>Рекомендации:</b>\n';
    message += '• Не давайте полный доступ новым администраторам\n';
    message += '• Назначайте только необходимые права\n';
    message += '• Регулярно проверяйте список администраторов';

    await ctx.editMessageText(message, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔧 Настроить права', 'admin_access_permissions')],
        [Markup.button.callback('🔙 Назад', 'admin_settings_access')]
      ])
    });

    await ctx.answerCbQuery();

  } catch (error) {
    console.error('Ошибка при отображении списка прав:', error);
    await ctx.answerCbQuery('❌ Ошибка');
  }
});

// 7. Настройка прав доступа (показать выбор администратора)
bot.action('admin_access_permissions', async (ctx) => {
  try {
    const ADMIN_ID = 1427347068;
    if (ctx.from.id !== ADMIN_ID) return;

    // Проверяем, может ли текущий администратор настраивать права
    if (!systemCache.accessSettings) {
      await ctx.answerCbQuery('❌ Настройки доступа не загружены');
      return;
    }
    
    const currentAdmin = systemCache.accessSettings.admins.find(a => a.id === ctx.from.id);
    if (!currentAdmin?.permissions?.fullAccess) {
      await ctx.answerCbQuery('❌ Только главный администратор может настраивать права');
      return;
    }

    const admins = systemCache.accessSettings.admins.filter(a => !a.permissions?.fullAccess);
    
    if (admins.length === 0) {
      await ctx.answerCbQuery('❌ Нет дополнительных администраторов для настройки прав');
      await showAccessSettings(ctx);
      return;
    }

    let message = '🔧 <b>НАСТРОЙКА ПРАВ ДОСТУПА</b>\n\n';
    message += 'Выберите администратора для настройки прав:\n\n';

    admins.forEach((admin, index) => {
      message += `<b>${index + 1}. ${admin.name}</b>\n`;
      message += `ID: ${admin.id}\n`;
      
      // Текущие права
      const currentPermissions = [];
      if (admin.permissions?.canManageUsers) currentPermissions.push('👥');
      if (admin.permissions?.canManageQuestions) currentPermissions.push('❓');
      if (admin.permissions?.canManageSettings) currentPermissions.push('⚙️');
      if (admin.permissions?.canSendBroadcasts) currentPermissions.push('📢');
      if (admin.permissions?.canViewAnalytics) currentPermissions.push('📊');
      
      message += `Текущие права: ${currentPermissions.join(' ') || 'нет'}\n`;
      message += `────────────────────\n`;
    });

    // Создаем кнопки для каждого администратора
    const keyboardButtons = admins.map(admin => [
      Markup.button.callback(`🔧 ${admin.name}`, `admin_access_edit_permissions_${admin.id}`)
    ]);
    
    keyboardButtons.push([
      Markup.button.callback('🔙 Назад', 'admin_settings_access')
    ]);

    const keyboard = Markup.inlineKeyboard(keyboardButtons);

    await ctx.editMessageText(message, {
      parse_mode: 'HTML',
      ...keyboard
    });

    await ctx.answerCbQuery();

  } catch (error) {
    console.error('Ошибка при отображении настройки прав:', error);
    await ctx.answerCbQuery('❌ Ошибка');
  }
});


// ========== ОБРАБОТКА ОШИБОЧНОЙ КОМАНДЫ /DEBUGUSERS ==========
bot.command('debugusers', async (ctx) => {
  await ctx.reply('⚠️ Возможно, вы имели в виду /debuguser (без s) или /debug');
});

// ========== ОБРАБОТКА ОСНОВНОГО МЕНЮ ==========

// Обработка даты татуировки
bot.hears('📅 Сегодня', async (ctx) => {
  const tattooDate = new Date();
  await updateTattooDate(ctx, tattooDate);
});

bot.hears('📅 Вчера', async (ctx) => {
  const tattooDate = new Date();
  tattooDate.setDate(tattooDate.getDate() - 1);
  await updateTattooDate(ctx, tattooDate);
});

// Пропуск указания даты
bot.hears('🚫 Пропустить', async (ctx) => {
  await ctx.reply(
    'Хорошо, ты можешь указать дату позже через команду /setdate\n\n' +
    'А теперь выбери что тебя интересует:',
    Markup.keyboard([
      ['🩹 Уход за тату', '⚠️ Возможные проблемы'],
      ['🚫 Что нельзя делать', '⏱ Мои напоминания'],
      ['📊 Статус заживления', '❓ Задать вопрос'],
      ['📅 Запись']  // новая кнопка
    ]).resize()
  );
  
  if (ctx.db && ctx.user) {
    await ctx.db.User.updateOne(
      { telegramId: ctx.from.id },
      { $set: { stage: 'main_menu' } }
    );
  }
});

bot.hears('📅 Запись', async (ctx) => {
  await ctx.reply(
    'Выберите тип записи:',
    Markup.inlineKeyboard([
      [Markup.button.callback('💬 Онлайн-консультация', 'appointment_consult')],
      [Markup.button.callback('🎨 Запись на тату', 'appointment_tattoo')],
      [Markup.button.callback('🔬 Лазерное удаление', 'appointment_laser')],
      [Markup.button.callback('🔙 Назад', 'appointment_back')]
    ])
  );
});

// Лазерное удаление
bot.hears('🔬 Лазерное удаление', async (ctx) => {
  await ctx.replyWithHTML(
    '🔬 <b>ЛАЗЕРНОЕ УДАЛЕНИЕ ТАТУИРОВКИ</b>\n\n' +
    '<b>Как проходит сеанс – от входа в студию до ухода домой:</b>\n\n' +
    '1️⃣ Мы встречаем вас, уточняем зону удаления, обсуждаем пожелания.\n' +
    '2️⃣ При необходимости наносим анестезию.\n' +
    '3️⃣ Настраиваем параметры аппарата под вашу тату.\n' +
    '4️⃣ Сам процесс занимает от 5 до 20 минут.\n' +
    '5️⃣ После процедуры – обработка, рекомендации, ответы на все вопросы.\n\n' +
    '❗️ <b>Важно:</b>\n' +
    '• Количество сеансов – индивидуально, зависит от глубины и плотности пигмента.\n' +
    '• Между сеансами нужен перерыв (обычно 1–1,5 месяца).\n' +
    '• Мы используем современный аппарат, сертифицированный и безопасный ✨️\n\n' +
    '💬 <i>Если ты долго откладываешь из-за сомнений – просто приходи на консультацию. Она бесплатная и ни к чему не обязывает.</i>\n\n' +
    'Вы можете записаться на приём через кнопку <b>«📅 Запись»</b> в главном меню.'
  );
});

// Функция обновления даты тату
async function updateTattooDate(ctx, date) {
  if (ctx.db && ctx.user) {
    await ctx.db.User.updateOne(
      { telegramId: ctx.from.id },
      { 
        $set: { 
          tattooDate: date,
          stage: 'main_menu',
          lastTattooUpdate: new Date()
        }
      }
    );
  }
  
  const daysPassed = Math.floor((new Date() - date) / (1000 * 60 * 60 * 24));
  
  await ctx.replyWithHTML(
    `✅ <b>Отлично! Запомнил дату:</b> ${date.toLocaleDateString('ru-RU')}\n` +
    `📅 <b>Прошло дней:</b> ${daysPassed}\n\n` +
    '<b>Теперь я могу давать тебе персонализированные рекомендации!</b>',
    Markup.keyboard([
      ['🩹 Уход за тату', '⚠️ Возможные проблемы'],
      ['🚫 Что нельзя делать', '⏱ Мои напоминания'],
      ['📊 Статус заживления', '❓ Задать вопрос'],
      ['📅 Запись']  // новая кнопка
    ]).resize()
  );
}

// Главное меню - Уход за тату
bot.hears('🩹 Уход за тату', async (ctx) => {
  if (!ctx.user.tattooDate) {
    return ctx.reply(
      'Сначала укажи дату татуировки!\n' +
      'Отправь "сегодня", "вчера" или конкретную дату.',
      Markup.keyboard([['📅 Сегодня', '📅 Вчера'], ['🚫 Пропустить']]).resize()
    );
  }
  
  const daysPassed = Math.floor((new Date() - ctx.user.tattooDate) / (1000 * 60 * 60 * 24));
  let carePlan = '';
  
  if (daysPassed <= 3) {
    carePlan = `🎯 <b>День ${daysPassed + 1} из 3: Первичный уход</b>\n\n` +
      '• Мойте 2-3 раза в день мягким мылом\n' +
      '• Наносите тонкий слой Бепантена, Пантенола или Метилурациловая мазь(Последний более дешёвый аналог)\n' +
      '• Не сдирайте образовавшиеся корочки\n' +
      '• Спите на чистом хлопковом белье\n' +
      '• Избегайте трения одеждой';
  } else if (daysPassed <= 7) {
    carePlan = `🎯 <b>День ${daysPassed + 1} из 7: Активное заживление</b>\n\n` +
      '• Перейдите на легкий увлажняющий крем\n' +
      '• Избегайте длительного контакта с водой\n' +
      '• Носите свободную одежду из натуральных тканей\n' +
      '• Начинается зуд - ни в коем случае не чешите!\n' +
      '• Можно аккуратно похлопывать';
  } else if (daysPassed <= 14) {
    carePlan = `🎯 <b>День ${daysPassed + 1} из 14: Завершающая фаза</b>\n\n` +
      '• Продолжайте увлажнять кожу\n' +
      '• Избегайте прямого солнца\n' +
      '• Можно принимать душ как обычно\n' +
      '• Шелушение - это нормально, не сдирайте\n' +
      '• Кожа может немного стягиваться';
  } else {
    carePlan = `🎯 <b>После 2 недель: Поддерживающий уход</b>\n\n` +
      '• Используйте солнцезащитный крем SPF 50+\n' +
      '• Можно плавать в бассейне/море\n' +
      '• Продолжайте увлажнять кожу\n' +
      '• Первый месяц - критически важен!\n' +
      '• При появлении проблем - к специалисту';
  }
  
  await ctx.replyWithHTML(
    `📅 <b>Татуировка сделана:</b> ${ctx.user.tattooDate.toLocaleDateString('ru-RU')}\n` +
    `⏳ <b>Прошло дней:</b> ${daysPassed}\n\n` +
    carePlan + 
    `\n\n⏰ <b>Следующий этап через:</b> ${Math.max(0, 14 - daysPassed)} дней`
  );
  
  // Сохраняем просмотр инструкции
  if (ctx.db) {
    await ctx.db.User.updateOne(
      { telegramId: ctx.from.id },
      { 
        $push: { 
          'activity.careViews': {
            date: new Date(),
            daysPassed: daysPassed
          }
        }
      }
    );
  }
});
// Статус заживления
bot.hears('📊 Статус заживления', async (ctx) => {
  if (!ctx.user || !ctx.user.tattooDate) {
    return ctx.reply(
      '❓ Вы ещё не указали дату татуировки.\n' +
      'Пожалуйста, отправьте /setdate или нажмите "📅 Сегодня" / "📅 Вчера", чтобы я мог рассчитать стадию заживления.',
      Markup.keyboard([
        ['📅 Сегодня', '📅 Вчера'],
        ['🚫 Пропустить']
      ]).resize()
    );
  }

  const tattooDate = new Date(ctx.user.tattooDate);
  const today = new Date();
  const daysPassed = Math.floor((today - tattooDate) / (1000 * 60 * 60 * 24));

  let stage = '';
  let description = '';

  if (daysPassed < 0) {
    stage = '⏳ Будущее';
    description = 'Дата татуировки ещё не наступила. Проверьте правильность введённой даты.';
  } else if (daysPassed <= 3) {
    stage = '🩹 Первичное заживление (1–3 дня)';
    description = 'Идёт активное выделение сукровицы, возможно покраснение и отёк. Важно соблюдать гигиену и использовать заживляющие мази.';
  } else if (daysPassed <= 7) {
    stage = '🌀 Активное заживление (4–7 дней)';
    description = 'Образуются корочки, появляется зуд. Ни в коем случае не сдирайте их! Продолжайте увлажнять кожу.';
  } else if (daysPassed <= 14) {
    stage = '✨ Шелушение и восстановление (1–2 недели)';
    description = 'Кожа активно обновляется, может шелушиться. Продолжайте использовать увлажняющий крем, избегайте трения.';
  } else if (daysPassed <= 30) {
    stage = '🌱 Завершение внешнего заживления (2–4 недели)';
    description = 'Тату выглядит зажившей, но внутренние слои кожи ещё восстанавливаются. Защищайте от солнца и не допускайте травм.';
  } else {
    stage = '✅ Полностью зажившая татуировка (более месяца)';
    description = 'Татуировка зажила. Для сохранения яркости используйте солнцезащитный крем и регулярно увлажняйте кожу.';
  }

  await ctx.replyWithHTML(
    `📊 <b>СТАТУС ЗАЖИВЛЕНИЯ</b>\n\n` +
    `📅 <b>Дата тату:</b> ${tattooDate.toLocaleDateString('ru-RU')}\n` +
    `⏳ <b>Прошло дней:</b> ${daysPassed}\n` +
    `📍 <b>Этап:</b> ${stage}\n\n` +
    `📝 <b>Описание:</b>\n${description}\n\n` +
    `💡 <i>Помните: каждый организм индивидуален, при появлении тревожных симптомов обратитесь к специалисту.</i>`
  );
});
// Проблемы - исправленная клавиатура
bot.hears('⚠️ Возможные проблемы', async (ctx) => {
  try {
    await ctx.reply(
      'Выберите проблему для получения подробной информации:',
      Markup.inlineKeyboard([
        [
          Markup.button.callback('🔴 Покраснение', 'problem_redness'),
          Markup.button.callback('👐 Сильный зуд', 'problem_itch')
        ],
        [
          Markup.button.callback('💪 Отёк', 'problem_swelling'),
          Markup.button.callback('🦠 Гной/выделения', 'problem_pus')
        ],
        [
          Markup.button.callback('🍂 Шелушение', 'problem_peeling'),
          Markup.button.callback('🎨 Потеря цвета', 'problem_fading')
        ]
      ]).resize()
    );
  } catch (error) {
    console.error('Ошибка при отправке клавиатуры проблем:', error);
    await ctx.reply('Произошла ошибка. Попробуйте позже.');
  }
});

bot.action('back_to_problems', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    'Выберите проблему для получения подробной информации:',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('🔴 Покраснение', 'problem_redness'),
        Markup.button.callback('👐 Сильный зуд', 'problem_itch')
      ],
      [
        Markup.button.callback('💪 Отёк', 'problem_swelling'),
        Markup.button.callback('🦠 Гной/выделения', 'problem_pus')
      ],
      [
        Markup.button.callback('🍂 Шелушение', 'problem_peeling'),
        Markup.button.callback('🎨 Потеря цвета', 'problem_fading')
      ]
    ]).resize()
  );
});

// Обработка инлайн-кнопок проблем (обновленные с кнопкой "Назад")
bot.action('problem_redness', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '🔴 <b>Покраснение вокруг татуировки</b>\n\n' +
    '📅 <b>Нормальные сроки:</b>\n' +
    '• Легкое покраснение - первые 2-3 дня\n' +
    '• Умеренное покраснение - до 5 дней\n\n' +
    
    '⚠️ <b>Когда беспокоиться:</b>\n' +
    '• Покраснение усиливается после 3-го дня\n' +
    '• Площадь покраснения увеличивается\n' +
    '• Появились красные полосы, расходящиеся от тату\n' +
    '• Есть пульсирующая или стреляющая боль\n' +
    '• Повышение температуры тела\n\n' +
    
    '💊 <b>Что делать:</b>\n' +
    '1. Приложить холодный компресс на 10-15 минут\n' +
    '2. Обеспечить доступ воздуха (не заклеивать)\n' +
    '3. Использовать антисептик без спирта (Хлоргексидин)\n' +
    '4. Нанести тонкий слой Бепантена, Пантенола или Метилурациловая мазь(Последний более дешёвый аналог)\n' +
    '5. Избегать трения одеждой\n\n' +
    
    '🚑 <b>СРОЧНО К ВРАЧУ если:</b>\n' +
    '• Температура выше 37.5°C\n' +
    '• Покраснение + гнойные выделения\n' +
    '• Сильная боль, не снимаемая анальгетиками\n' +
    '• Признаки сепсиса (озноб, слабость, тахикардия)\n\n' +
    
    '⬅️ <i>Используйте кнопку "Назад" для возврата к списку проблем</i>',
    {
      parse_mode: 'HTML',
      ...addBackToProblemsButton()
    }
  );
});

bot.action('problem_itch', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '🔵 <b>Сильный зуд после нанесения татуировки</b>\n\n' +
    '📅 <b>Физиологический зуд (норма):</b>\n' +
    '• Дни 3-10: активная фаза заживления\n' +
    '• Дни 10-21: шелушение и регенерация\n\n' +
    
    '⚠️ <b>Патологический зуд (проблема):</b>\n' +
    '• Зуд начинается в первые 24 часа\n' +
    '• Сопровождается сыпью или волдырями\n' +
    '• Распространяется за пределы тату\n' +
    '• Не прекращается после 3 недель\n\n' +
    
    '💊 <b>Безопасные методы облегчения:</b>\n' +
    '1. Похлопывание (ни в коем случае не чесать!)\n' +
    '2. Холодный компресс через ткань\n' +
    '3. Увлажняющий крем с пантенолом\n' +
    '4. Антигистаминные (по согласованию с врачом)\n' +
    '5. Свободная хлопковая одежда\n\n' +
    
    '💡 <b>Профилактика:</b>\n' +
    '• Избегать перегрева и потливости\n' +
    '• Использовать гипоаллергенные средства ухода\n' +
    '• Исключить алкоголь (усиливает зуд)\n\n' +
    
    '🚑 <b>К врачу если:</b>\n' +
    '• Зуд невыносимый, мешает спать\n' +
    '• Появились пузыри с жидкостью\n' +
    '• Признаки аллергической реакции\n\n' +
    
    '⬅️ <i>Используйте кнопку "Назад" для возврата к списку проблем</i>',
    {
      parse_mode: 'HTML',
      ...addBackToProblemsButton()
    }
  );
});

bot.action('problem_swelling', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '⚪ <b>Отёк после татуировки</b>\n\n' +
    '📅 <b>Нормальный отёк:</b>\n' +
    '• Первые 24-48 часов - максимальный\n' +
    '• Спадает на 3-4 день\n' +
    '• Локализован только в зоне тату\n\n' +
    
    '⚠️ <b>Тревожные признаки:</b>\n' +
    '• Отёк нарастает после 2-го дня\n' +
    '• Распространяется на соседние области\n' +
    '• Кожа сильно натянута, блестит\n' +
    '• Появление "апельсиновой корки"\n' +
    '• Ощущение распираения\n\n' +
    
    '💊 <b>Первая помощь:</b>\n' +
    '1. Приподнять конечность выше сердца\n' +
    '2. Холодные компрессы (15 мин каждый час)\n' +
    '3. Противовоспалительные мази (Траумель)\n' +
    '4. Уменьшить потребление соли\n' +
    '5. Обильное питье чистой воды\n\n' +
    
    '🩺 <b>Медицинская помощь:</b>\n' +
    '• Лимфодренажный массаж (только у специалиста)\n' +
    '• Аппаратные процедуры (по назначению врача)\n' +
    '• Медикаментозная терапия при необходимости\n\n' +
    
    '🚑 <b>СРОЧНО если:</b>\n' +
    '• Отёк + покраснение + температура\n' +
    '• Нарушение подвижности конечности\n' +
    '• Чувство онемения или покалывания\n\n' +
    
    '⬅️ <i>Используйте кнопку "Назад" для возврата к списку проблем</i>',
    {
      parse_mode: 'HTML',
      ...addBackToProblemsButton()
    }
  );
});

bot.action('problem_pus', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '🟡 <b>Гнойные выделения из татуировки</b>\n\n' +
    '🟢 <b>Нормальные выделения:</b>\n' +
    '• Прозрачная или светло-желтая жидкость\n' +
    '• Небольшое количество в первые 3 дня\n' +
    '• Без запаха\n\n' +
    
    '🔴 <b>Признаки инфицирования:</b>\n' +
    '• Густой желтый или зеленный гной\n' +
    '• Неприятный (гнилостный) запах\n' +
    '• Выделения обильные, постоянные\n' +
    '• Образование корок с гноем под ними\n\n' +
    
    '💊 <b>Действия при инфицировании:</b>\n' +
    '1. НЕМЕДЛЕННАЯ консультация врача!\n' +
    '2. До визита: промывать Хлоргексидином 2-3 раза\n' +
    '3. Накладывать стерильные повязки\n' +
    '4. Не использовать мази без назначения\n' +
    '5. Не принимать антибиотики самостоятельно!\n\n' +
    
    '🏥 <b>Что будет делать врач:</b>\n' +
    '• Взятие посева на флору\n' +
    '• Назначение антибиотиков (местно/системно)\n' +
    '• Профессиональная обработка раны\n' +
    '• При необходимости - дренирование\n\n' +
    
    '⚠️ <b>ОСОБО ОПАСНО:</b>\n' +
    '• Staphylococcus aureus (золотистый стафилококк)\n' +
    '• Streptococcus pyogenes\n' +
    '• Pseudomonas aeruginosa\n' +
    '• Может привести к сепсису!\n\n' +
    
    '⬅️ <i>Используйте кнопку "Назад" для возврата к списку проблем</i>',
    {
      parse_mode: 'HTML',
      ...addBackToProblemsButton()
    }
  );
});

bot.action('problem_peeling', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '🟤 <b>Шелушение кожи после татуировки</b>\n\n' +
    
    '📅 <b>Этапы нормального шелушения:</b>\n' +
    '• <b>День 3-5:</b> Появление первых корочек\n' +
    '• <b>День 5-10:</b> Активное шелушение, кожа сходит "пергаментными" кусочками\n' +
    '• <b>День 10-21:</b> Завершающая фаза, под шелушением новая розовая кожа\n\n' +
    
    '✅ <b>Что нормально:</b>\n' +
    '• Шелушение только в зоне тату\n' +
    '• Кожа отходит мелкими фрагментами\n' +
    '• Под шелушением - здоровая розовая кожа\n' +
    '• Нет боли, только легкий зуд\n\n' +
    
    '🚫 <b>Что НЕЛЬЗЯ делать:</b>\n' +
    '1. ❌ Сдирать корочки и шелушащуюся кожу\n' +
    '2. ❌ Использовать скрабы, пилинги, мочалки\n' +
    '3. ❌ Распаривать в бане/сауне\n' +
    '4. ❌ Чесать или тереть\n' +
    '5. ❌ Отмачивать в воде\n\n' +
    
    '💡 <b>Правильный уход:</b>\n' +
    '1. Мойте 2 раза в день мягким мылом\n' +
    '2. Промокайте бумажным полотенцем\n' +
    '3. Наносите тонкий слой увлажняющего крема\n' +
    '4. Дайте коже "дышать" 15-20 минут\n' +
    '5. Носите свободную хлопковую одежду\n\n' +
    
    '🩺 <b>Рекомендуемые средства:</b>\n' +
    '• Бепантен (декспантенол 5%), Пантенола или Метилурациловая мазь(Последний более дешёвый аналог)\n' +
    '• Пантенол спрей\n' +
    '• La Roche-Posay Cicaplast Baume B5\n' +
    '• Avene Cicalfate+ Restorative Protective Cream\n' +
    '• Мазь с календулой (гипоаллергенная)\n\n' +
    
    '⚠️ <b>Когда к врачу:</b>\n' +
    '• Шелушение началось в первые 24 часа\n' +
    '• Под кожей гной или мокнутие\n' +
    '• Сильная боль при шелушении\n' +
    '• Кожа сходит большими пластами\n' +
    '• Признаки инфекции (краснота, жар)\n\n' +
    
    '⬅️ <i>Используйте кнопку "Назад" для возврата к списку проблем</i>',
    {
      parse_mode: 'HTML',
      ...addBackToProblemsButton()
    }
  );
});

bot.action('problem_fading', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '⚫ <b>Потеря цвета и выцветание татуировки</b>\n\n' +
    
    '🎨 <b>Естественный процесс выцветания:</b>\n' +
    '• <b>1 месяц:</b> Потеря 20-30% яркости\n' +
    '• <b>3-6 месяцев:</b> Стабилизация цвета\n' +
    '• <b>1 год:</b> Окончательное закрепление пигмента\n' +
    '• <b>5+ лет:</b> Медленное выцветание (1-3% в год)\n\n' +
    
    '🔍 <b>Цвета, которые выцветают быстрее:</b>\n' +
    '1. <b>Белый</b> - самый нестабильный, желтеет\n' +
    '2. <b>Желтый</b> - чувствителен к УФ-излучению\n' +
    '3. <b>Красный</b> - может давать аллергию и выцветать\n' +
    '4. <b>Фиолетовый/сиреневый</b> - теряют насыщенность\n' +
    '5. <b>Зеленный</b> - может меняться на синий оттенок\n\n' +
    
    '☀️ <b>Главные враги цвета:</b>\n' +
    '1. <b>Солнце (УФ-лучи)</b> - разрушает пигмент\n' +
    '2. <b>Хлорированная вода</b> - вымывает краску\n' +
    '3. <b>Солярий</b> - интенсивное УФ-излучение\n' +
    '4. <b>Агрессивные химикаты</b> - скрабы, кислоты\n' +
    '5. <b>Некоторые лекарства</b> - антибиотики, ретиноиды\n\n' +
    
    '🛡️ <b>Как сохранить цвет:</b>\n' +
    '1. <b>SPF 50+</b> на тату при любом солнце\n' +
    '2. <b>Не купаться</b> в бассейне/море 1 месяц\n' +
    '3. <b>Не посещать солярий</b> 6 месяцев\n' +
    '4. <b>Увлажнять</b> кожу ежедневно\n' +
    '5. <b>Избегать трения</b> одеждой\n\n' +
    
    '💊 <b>Что влияет на стойкость:</b>\n' +
    '• <b>Качество пигментов</b> - профессиональные vs дешевые\n' +
    '• <b>Глубина введения</b> - оптимально 1-2 мм\n' +
    '• <b>Тип кожи</b> - жирная кожа быстрее теряет цвет\n' +
    '• <b>Местоположение</b> - руки/шея выцветают быстрее\n' +
    '• <b>Уход в период заживления</b>\n\n' +
    
    '🔧 <b>Коррекция и восстановление:</b>\n' +
    '• Первая коррекция: через 4-8 недель\n' +
    '• Последующие подкрашивания: каждые 3-5 лет\n' +
    '• Лазерное удаление + новое тату при сильном выцветания\n' +
    '• Использование более стойких пигментов\n\n' +
    
    '⚠️ <b>Тревожные признаки:</b>\n' +
    '• Цвет резко побледнел за 2 недели\n' +
    '• Пигмент "поплыл" за контуры\n' +
    '• Изменение цвета (синий → зеленый)\n' +
    '• Пятнистое, неравномерное выцветание\n' +
    '• Аллергическая реакция на пигмент\n\n' +
    
    '⬅️ <i>Используйте кнопку "Назад" для возврата к списку проблем</i>',
    {
      parse_mode: 'HTML',
      ...addBackToProblemsButton()
    }
  );
});

// Раздел "Что нельзя делать"
bot.hears('🚫 Что нельзя делать', async (ctx) => {
  await ctx.replyWithHTML(
    '🚫 <b>ПОЛНЫЙ СПИСОК ЗАПРЕТОВ ПОСЛЕ ТАТУИРОВКИ</b>\n\n' +
    'Соблюдение этих правил критически важно для красивого заживления!',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('🌞 Солнце и вода', 'taboo_sun_water'),
        Markup.button.callback('👕 Одежда и трение', 'taboo_clothes')
      ],
      [
        Markup.button.callback('💊 Лекарства и алкоголь', 'taboo_meds_alcohol'),
        Markup.button.callback('🏃 Активность и спорт', 'taboo_sports')
      ],
      [
        Markup.button.callback('🧼 Косметика и процедуры', 'taboo_cosmetics'),
        Markup.button.callback('⚠️ Абсолютные запреты', 'taboo_absolute')
      ],
      [
        Markup.button.callback('📋 Весь список', 'taboo_full_list')
      ]
    ]).resize()
  );
});

// ========== ОБРАБОТЧИКИ ДЛЯ ПОДРАЗДЕЛОВ "ЧТО НЕЛЬЗЯ" ==========
// 1. Солнце и вода - исправленный вариант
bot.action('taboo_sun_water', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '🌞 <b>СОЛНЦЕ И ВОДА - ГЛАВНЫЕ ВРАГИ НОВОЙ ТАТУИРОВКИ</b>\n\n' +
    
    '☀️ <b>Солнце (первые 4 недели):</b>\n' +
    '• ❌ Загорать на солнце\n' +
    '• ❌ Посещать солярий\n' +
    '• ❌ Находиться на открытом солнце без защиты\n' +
    '• ❌ Использовать автозагар\n' +
    '• ✅ Только SPF 50+ после 2 недель\n\n' +
    
    '💧 <b>Вода (первые 2 недели):</b>\n' +
    '• ❌ Плавать в бассейне (хлор)\n' +
    '• ❌ Купаться в море/океане (соль)\n' +
    '• ❌ Принимать ванну (долгое погружение)\n' +
    '• ❌ Ходить в баню/сауну\n' +
    '• ❌ Использовать джакузи\n' +
    '• ✅ Только короткий душ (5-7 минут)\n\n' +
    
    '🚿 <b>Правила душа:</b>\n' +
    '• Температура воды не выше 37°C\n' +
    '• Не направлять сильную струю на тату\n' +
    '• Не использовать жесткие мочалки\n' +
    '• Промокать, не тереть\n' +
    '• Наносить крем после полного высыхания\n\n' +
    
    '⬅️ <i>Используйте кнопку "Назад" для возврата</i>',
    {
      parse_mode: 'HTML',
      ...addBackButton()
    }
  );
});

// 2. Одежда и трение
bot.action('taboo_clothes', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '👕 <b>ОДЕЖДА И ТРЕНИЕ - ЧТО НОСИТЬ И ИЗБЕГАТЬ</b>\n\n' +
    
    '🚫 <b>Запрещенная одежда (первые 2 недели):</b>\n' +
    '• ❌ Обтягивающая, узкая одежда\n' +
    '• ❌ Синтетические ткани (нейлон, полиэстер)\n' +
    '• ❌ Шерсть, грубые ткани\n' +
    '• ❌ Джинсы на тату на ноге/бедре\n' +
    '• ❌ Рюкзаки/сумки на плече с тату\n' +
    '• ❌ Тесная обувь на тату на ноге\n\n' +
    
    '✅ <b>Рекомендуемая одежда:</b>\n' +
    '• Хлопок 100% (дышащий)\n' +
    '• Лен, бамбук\n' +
    '• Свободный крой\n' +
    '• Мягкие швы\n' +
    '• Светлые цвета (меньше нагреваются)\n\n' +
    
    '🛏️ <b>Сон и постель:</b>\n' +
    '• Спать на чистом белье (менять каждые 2-3 дня)\n' +
    '• Использовать хлопковую простынь\n' +
    '• Не накрывать тату плотным одеялом\n' +
    '• Избегать трения о постель\n\n' +
    
    '🎒 <b>Аксессуары:</b>\n' +
    '• Избегать ремней на тату на животе/спине\n' +
    '• Не носить часы/браслеты на руке с тату\n' +
    '• Сумки на противоположном плече\n\n' +
    
    '⬅️ <i>Используйте кнопку "Назад" для возврата</i>',
    {
      parse_mode: 'HTML',
      ...addBackButton()
    }
  );
});

// 3. Лекарства и алкоголь
bot.action('taboo_meds_alcohol', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '💊 <b>ЛЕКАРСТВА, АЛКОГОЛЬ И ПИТАНИЕ</b>\n\n' +
    
    '🍷 <b>Алкоголь (первые 3 дня):</b>\n' +
    '• ❌ Любой алкоголь (пиво, вино, крепкое)\n' +
    '• ❌ Энергетические напитки\n' +
    '• ✅ Минеральная вода 2+ литра в день\n' +
    '• ✅ Травяные чаи, морсы\n\n' +
    
    '💊 <b>Лекарства (консультируйтесь с врачом!):</b>\n' +
    '• ❌ Аспирин (разжижает кровь)\n' +
    '• ❌ Ибупрофен (может усилить кровотечение)\n' +
    '• ❌ Антикоагулянты (если не назначены врачом)\n' +
    '• ✅ Парацетамол (при необходимости)\n' +
    '• ✅ Антигистаминные (по назначению)\n\n' +
    
    '🚬 <b>Вредные привычки:</b>\n' +
    '• ❌ Курение (замедляет заживление)\n' +
    '• ❌ Наркотические вещества\n' +
    '• ❌ Чрезмерное потребление кофеина\n\n' +
    
    '🥗 <b>Питание (первые 3 дня):</b>\n' +
    '• ❌ Острая, соленая пища (усиливает отек)\n' +
    '• ❌ Фастфуд, полуфабрикаты\n' +
    '• ❌ Аллергены (если есть склонность)\n' +
    '• ✅ Белок (мясо, рыба, яйца)\n' +
    '• ✅ Витамин C (цитрусовые, болгарский перец)\n' +
    '• ✅ Цинк (орехи, семечки)\n\n' +
    
    '⬅️ <i>Используйте кнопку "Назад" для возврата</i>',
    {
      parse_mode: 'HTML',
      ...addBackButton()
    }
  );
});

// 4. Активность и спорт
bot.action('taboo_sports', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '🏃 <b>ФИЗИЧЕСКАЯ АКТИВНОСТЬ И СПОРТ</b>\n\n' +
    
    '⏰ <b>Сроки ограничений:</b>\n' +
    '• <b>Первые 48 часов:</b> Полный покой\n' +
    '• <b>3-7 дней:</b> Легкая активность\n' +
    '• <b>2-4 недели:</b> Ограниченные тренировки\n' +
    '• <b>После 1 месяца:</b> Полное восстановление\n\n' +
    
    '🚫 <b>Запрещенные активности (первые 2 недели):</b>\n' +
    '• ❌ Тяжелая атлетика, пауэрлифтинг\n' +
    '• ❌ Контактные виды спорта (бокс, борьба)\n' +
    '• ❌ Плавание, водные виды спорта\n' +
    '• ❌ Бег, прыки (если тату на ногах)\n' +
    '• ❌ Йога, растяжка (если тату на суставах)\n' +
    '• ❌ Велоспорт (если тату на ягодицах/бедрах)\n\n' +
    
    '✅ <b>Разрешенная активность:</b>\n' +
    '• Пешие прогулки\n' +
    '• Легкая гимнастика (без нагрузки на тату)\n' +
    '• Дыхательные упражнения\n' +
    '• Медитация\n\n' +
    
    '💦 <b>Потоотделение:</b>\n' +
    '• Пот раздражает свежую татуировку\n' +
    '• Содержит соли и бактерии\n' +
    '• Может вызвать воспаление\n' +
    '• После активности - сразу душ!\n\n' +
    
    '⬅️ <i>Используйте кнопку "Назад" для возврата</i>',
    {
      parse_mode: 'HTML',
      ...addBackButton()
    }
  );
});

// 5. Косметика и процедуры
bot.action('taboo_cosmetics', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '🧼 <b>КОСМЕТИКА И ПРОЦЕДУРЫ</b>\n\n' +
    
    '🚫 <b>Запрещенные косметические средства:</b>\n' +
    '• ❌ Спиртосодержащие лосьоны\n' +
    '• ❌ Скрабы, пилинги, энзимы\n' +
    '• ❌ Масла с отдушками\n' +
    '• ❌ Кремы с ретиноидами (Retin-A)\n' +
    '• ❌ Гормональные мази (без назначения)\n' +
    '• ❌ Антиперспиранты (если тату в подмышках)\n\n' +
    
    '✅ <b>Разрешенные средства:</b>\n' +
    '• Бепантена, Пантенола или Метилурациловая мазь(Последний более дешёвый аналог)\n' +
    '• Детский крем без отдушек\n' +
    '• Кремы с декспантенолом\n' +
    '• Хлоргексидин (для обработки)\n' +
    '• Физраствор (для промывания)\n\n' +
    
    '💆 <b>Косметические процедуры (первые 4 недели):</b>\n' +
    '• ❌ Массаж в зоне тату\n' +
    '• ❌ Обертывания\n' +
    '• ❌ Эпиляция воском/сахаром\n' +
    '• ❌ Лазерная эпиляция\n' +
    '• ❌ Химические пилинги\n' +
    '• ❌ Мезотерапия, биоревитализация\n\n' +
    
    '💅 <b>Уход за тату после заживления:</b>\n' +
    '• SPF 50+ всегда на солнце\n' +
    '• Регулярное увлажнение\n' +
    '• Кремы с витамином E\n' +
    '• Масло ши, какао для питания\n\n' +
    
    '⬅️ <i>Используйте кнопку "Назад" для возврата</i>',
    {
      parse_mode: 'HTML',
      ...addBackButton()
    }
  );
});

// 6. Абсолютные запреты
bot.action('taboo_absolute', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '⚠️ <b>АБСОЛЮТНЫЕ ЗАПРЕТЫ - НИКОГДА НЕ ДЕЛАЙТЕ ЭТОГО!</b>\n\n' +
    
    '🔥 <b>Критические ошибки:</b>\n' +
    '1. ❌ <b>Сдирать корочки и шелушения</b>\n' +
    '   • Вырываете пигмент\n' +
    '   • Оставляете шрамы\n' +
    '   • Вызываете инфекцию\n\n' +
    
    '2. ❌ <b>Чесать татуировку</b>\n' +
    '   • Повреждаете кожу\n' +
    '   • Заносите бактерии\n' +
    '   • Деформируете рисунок\n\n' +
    
    '3. ❌ <b>Заклеивать пластырем/пленкой после 2-го дня</b>\n' +
    '   • Создаете парниковый эффект\n' +
    '   • Размножаются бактерии\n' +
    '   • Вызываете мацерацию кожи\n\n' +
    
    '4. ❌ <b>Использовать народные средства без консультации</b>\n' +
    '   • Мед, алоэ (могут вызвать аллергию)\n' +
    '   • Водка, спирт (сжигают кожу)\n' +
    '   • Травяные отвары (могут инфицировать)\n\n' +
    
    '5. ❌ <b>Заниматься самолечением при инфекции</b>\n' +
    '   • Антибиотики без назначения\n' +
    '   • Гормональные мази\n' +
    '   • Прижигающие растворы\n\n' +
    
    '🆘 <b>Если что-то пошло не так:</b>\n' +
    '• Немедленно к врачу\n' +
    '• Не скрывайте симптомы\n' +
    '• Следуйте только назначениям специалиста\n\n' +
    
    '⬅️ <i>Используйте кнопку "Назад" для возврата</i>',
    {
      parse_mode: 'HTML',
      ...addBackButton()
    }
  );
});

// 7. Полный список
bot.action('taboo_full_list', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '📋 <b>ПОЛНЫЙ СПИСОК ЗАПРЕТОВ ПО ДНЯМ</b>\n\n' +
    
    '📅 <b>ПЕРВЫЕ 24 ЧАСА:</b>\n' +
    '• Не снимать защитную пленку\n' +
    '• Не мочить\n' +
    '• Не тереть, не давить\n' +
    '• Полный покой\n' +
    '• Никакого алкоголя\n\n' +
    
    '📅 <b>ДНИ 2-7:</b>\n' +
    '• Не сдирать корочки\n' +
    '• Не чесать\n' +
    '• Не загорать\n' +
    '• Не плавать\n' +
    '• Не париться\n' +
    '• Не носить тесную одежду\n' +
    '• Не заниматься спортом\n\n' +
    
    '📅 <b>НЕДЕЛЯ 2-4:</b>\n' +
    '• Не использовать скрабы\n' +
    '• Не ходить в солярий\n' +
    '• Не делать эпиляцию в зоне тату\n' +
    '• Не наносить косметику на тату\n' +
    '• Избегать интенсивного трения\n\n' +
    
    '📅 <b>ПЕРВЫЙ МЕСЯЦ:</b>\n' +
    '• SPF 50+ при любом солнце\n' +
    '• Избегать хлорированной воды\n' +
    '• Не делать пилинги\n' +
    '• Беречь от механических повреждений\n\n' +
    
    '💡 <b>Общее правило:</b>\n' +
    'Если сомневаетесь - лучше не делайте!\n' +
    'Здоровье татуировки важнее временных ограничений.\n\n' +
    
    '⬅️ <i>Используйте кнопку "Назад" для возврата</i>',
    {
      parse_mode: 'HTML',
      ...addBackButton()
    }
  );
});

// Обработчик для возврата к списку запретов
bot.action('back_to_taboo', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '🚫 <b>ПОЛНЫЙ СПИСОК ЗАПРЕТОВ ПОСЛЕ ТАТУИРОВКИ</b>\n\n' +
    'Соблюдение этих правил критически важно для красивого заживления!',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('🌞 Солнце и вода', 'taboo_sun_water'),
        Markup.button.callback('👕 Одежда и трение', 'taboo_clothes')
      ],
      [
        Markup.button.callback('💊 Лекарства и алкоголь', 'taboo_meds_alcohol'),
        Markup.button.callback('🏃 Активность и спорт', 'taboo_sports')
      ],
      [
        Markup.button.callback('🧼 Косметика и процедуры', 'taboo_cosmetics'),
        Markup.button.callback('⚠️ Абсолютные запреты', 'taboo_absolute')
      ],
      [
        Markup.button.callback('📋 Весь список', 'taboo_full_list')
      ]
    ]).resize()
  );
});

// ========== РАЗДЕЛ "ЗАДАТЬ ВОПРОС" ==========

bot.hears('❓ Задать вопрос', async (ctx) => {
  await ctx.replyWithHTML(
    '❓ <b>ЧАСТО ЗАДАВАЕМЫЕ ВОПРОСЫ</b>\n\n' +
    'Выберите интересующий вас вопрос из списка ниже:',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('⏳ Сколько заживает тату?', 'question_healing_time'),
        Markup.button.callback('💧 Когда можно мыться?', 'question_washing')
      ],
      [
        Markup.button.callback('🌞 Когда можно загорать?', 'question_sun'),
        Markup.button.callback('🏊 Когда можно плавать?', 'question_swimming')
      ],
      [
        Markup.button.callback('🎨 Нужна ли коррекция?', 'question_correction'),
        Markup.button.callback('💊 Какие кремы использовать?', 'question_creams')
      ],
      [
        Markup.button.callback('📞 Связаться с поддержкой', 'question_support'),
        Markup.button.callback('💬 Задать свой вопрос', 'question_custom')
      ]
    ]).resize()
  );
});

// Обработчик возврата к списку вопросов
bot.action('back_to_questions', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '❓ <b>ЧАСТО ЗАДАВАЕМЫЕ ВОПРОСЫ</b>\n\n' +
    'Выберите интересующий вас вопрос из списка ниже:',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('⏳ Сколько заживает тату?', 'question_healing_time'),
        Markup.button.callback('💧 Когда можно мыться?', 'question_washing')
      ],
      [
        Markup.button.callback('🌞 Когда можно загорать?', 'question_sun'),
        Markup.button.callback('🏊 Когда можно плавать?', 'question_swimming')
      ],
      [
        Markup.button.callback('🎨 Нужна ли коррекция?', 'question_correction'),
        Markup.button.callback('💊 Какие кремы использовать?', 'question_creams')
      ],
      [
        Markup.button.callback('📞 Связаться с поддержкой', 'question_support'),
        Markup.button.callback('💬 Задать свой вопрос', 'question_custom')
      ]
    ]).resize()
  );
});

// 1. Сколько заживает тату?
bot.action('question_healing_time', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '⏳ <b>СКОЛЬКО ЗАЖИВАЕТ ТАТУИРОВКА?</b>\n\n' +
    
    '📅 <b>Этапы заживления:</b>\n' +
    '• <b>Дни 1-3:</b> Покраснение, отек, выделение сукровицы\n' +
    '• <b>Дни 3-7:</b> Образование корочек, сильный зуд\n' +
    '• <b>Дни 7-14:</b> Активное шелушение, кожа обновляется\n' +
    '• <b>Дни 14-30:</b> Внешнее заживление завершено, внутреннее продолжается\n' +
    '• <b>1-3 месяца:</b> Полное заживление всех слоев кожи\n\n' +
    
    '⚡ <b>Факторы, влияющие на заживление:</b>\n' +
    '• Размер и сложность татуировки\n' +
    '• Местоположение на теле (руки/ноги заживают дольше)\n' +
    '• Качество работы мастера\n' +
    '• Правильность ухода\n' +
    '• Индивидуальные особенности организма\n\n' +
    
    '💡 <b>Советы для быстрого заживления:</b>\n' +
    '1. Строго соблюдайте рекомендации по уходу\n' +
    '2. Не сдирайте корочки и шелушения\n' +
    '3. Избегайте попадания воды в первые дни\n' +
    '4. Носите свободную одежду из натуральных тканей\n' +
    '5. Не употребляйте алкоголь первые 3 дня\n\n' +
    
    '⚠️ <b>Когда стоит беспокоиться:</b>\n' +
    '• Заживление затянулось более 4 недель\n' +
    '• Появились признаки инфекции (гнус, температура)\n' +
    '• Сильная боль не уменьшается через 5 дней\n' +
    '• Аллергическая реакция на пигменты\n\n' +
    
    '⬅️ <i>Используйте кнопку "Назад" для возврата к списку вопросов</i>',
    {
      parse_mode: 'HTML',
      ...addBackToQuestionsButton()
    }
  );
});

// 2. Когда можно мыться?
bot.action('question_washing', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '💧 <b>КОГДА МОЖНО МЫТЬ ТАТУИРОВКУ?</b>\n\n' +
    
    '🚫 <b>Первые 24 часа:</b>\n' +
    '• Не мочить татуировку вообще\n' +
    '• Не снимать защитную пленку\n' +
    '• Избегать попадания воды\n\n' +
    
    '🚿 <b>Со 2-го дня:</b>\n' +
    '• Можно принимать быстрый душ (5-7 минут)\n' +
    '• Температура воды не выше 37°C\n' +
    '• Не направлять сильную струю на тату\n' +
    '• Использовать мягкое мыло без отдушек\n' +
    '• Промокать чистым полотенцем, не тереть\n\n' +
    
    '🛁 <b>Когда можно принимать ванну:</b>\n' +
    '• Через 2 недели после нанесения\n' +
    '• Вода должна быть теплой, не горячей\n' +
    '• Не использовать соли, масла, пену для ванн\n' +
    '• Не погружаться полностью более 15 минут\n\n' +
    
    '💡 <b>Правила мытья:</b>\n' +
    '1. Мойте руки перед прикосновением к тату\n' +
    '2. Используйте жидкое антибактериальное мыло\n' +
    '3. Легкими движениями очищайте тату\n' +
    '4. Тщательно смойте мыло\n' +
    '5. Промокните бумажным полотенцем\n' +
    '6. Дайте высохнуть 15-20 минут\n' +
    '7. Нанесите тонкий слой крема\n\n' +
    
    '⚠️ <b>Запрещено:</b>\n' +
    '• Посещать баню/сауну 2 недели\n' +
    '• Купаться в открытых водоемах 1 месяц\n' +
    '• Использовать скрабы и мочалки 1 месяц\n' +
    '• Распаривать татуировку\n\n' +
    
    '⬅️ <i>Используйте кнопку "Назад" для возврата к списку вопросов</i>',
    {
      parse_mode: 'HTML',
      ...addBackToQuestionsButton()
    }
  );
});

// 3. Когда можно загорать?
bot.action('question_sun', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '🌞 <b>КОГДА МОЖНО ЗАГОРАТЬ ПОСЛЕ ТАТУ?</b>\n\n' +
    
    '🚫 <b>Абсолютный запрет (первые 2 недели):</b>\n' +
    '• Не находиться на открытом солнце\n' +
    '• Не посещать солярий\n' +
    '• Не использовать автозагар\n\n' +
    
    '⚠️ <b>Первые 2-4 недели:</b>\n' +
    '• Избегать прямых солнечных лучей\n' +
    '• При выходе на солнце закрывать тату одеждой\n' +
    '• Можно использовать SPF 50+ на полностью зажившую кожу\n\n' +
    
    '✅ <b>После 1 месяца:</b>\n' +
    '• Можно загорать, но с осторожностью\n' +
    '• Обязательно использовать солнцезащитный крем SPF 50+\n' +
    '• Наносить крем каждые 2 часа и после купания\n' +
    '• Избегать пиковых часов (12:00-16:00)\n\n' +
    
    '🔥 <b>Почему солнце опасно:</b>\n' +
    '• УФ-лучи разрушают пигмент\n' +
    '• Вызывают выцветание татуировки\n' +
    '• Могут привести к ожогам на нежной коже\n' +
    '• Усиливают риск аллергических реакций\n' +
    '• Замедляют процесс заживления\n\n' +
    
    '🛡️ <b>Как защитить тату:</b>\n' +
    '1. SPF 50+ с UVA/UVB защитой\n' +
    '2. Одежда из плотных натуральных тканей\n' +
    '3. Находиться в тени\n' +
    '4. Носить солнцезащитные накидки\n' +
    '5. Увлажнять кожу после загара\n\n' +
    
    '💡 <b>Рекомендации для сохранения цвета:</b>\n' +
    '• Первые 6 месяцев - максимальная защита\n' +
    '• Даже через год использовать SPF 30+\n' +
    '• После загара наносить восстанавливающий крем\n' +
    '• Избегать солярия минимум 6 месяцев\n\n' +
    
    '⬅️ <i>Используйте кнопку "Назад" для возврата к списку вопросов</i>',
    {
      parse_mode: 'HTML',
      ...addBackToQuestionsButton()
    }
  );
});

// 4. Когда можно плавать?
bot.action('question_swimming', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '🏊 <b>КОГДА МОЖНО ПЛАВАТЬ ПОСЛЕ ТАТУ?</b>\n\n' +
    
    '🚫 <b>Абсолютный запрет (первые 2 недели):</b>\n' +
    '• Не плавать в бассейне\n' +
    '• Не купаться в море/океане\n' +
    '• Не посещать аквапарки\n' +
    '• Не принимать ванны/джакузи\n\n' +
    
    '⚠️ <b>Первые 2-4 недели:</b>\n' +
    '• Только душ с проточной водой\n' +
    '• Избегать длительного контакта с водой\n' +
    '• После душа тщательно высушивать тату\n\n' +
    
    '✅ <b>После 1 месяца:</b>\n' +
    '• Можно плавать, но с осторожностью\n' +
    '• Первые заплывы не более 15-20 минут\n' +
    '• После купания сразу принимать душ\n' +
    '• Тщательно сушить и увлажнять кожу\n\n' +
    
    '💧 <b>Опасности воды:</b>\n' +
    '• <b>Хлор</b> в бассейне - сушит кожу, вызывает раздражение\n' +
    '• <b>Соль</b> в море - разъедает свежую тату, усиливает шелушение\n' +
    '• <b>Бактерии</b> в водоемах - риск инфекции\n' +
    '• <b>Песок</b> - абразивное действие, может повредить кожу\n\n' +
    
    '🛡️ <b>Правила безопасного купания:</b>\n' +
    '1. Дождаться полного заживления (4 недели)\n' +
    '2. Первый раз плавать не более 15 минут\n' +
    '3. Сразу после купания принять душ с пресной водой\n' +
    '4. Использовать мягкое мыло\n' +
    '5. Промокнуть полотенцем, не тереть\n' +
    '6. Нанести увлажняющий крем\n' +
    '7. Избегать купания в грязных водоемах\n\n' +
    
    '⚠️ <b>Если намочили случайно:</b>\n' +
    '• Немедленно промокнуть чистым полотенцем\n' +
    '• Обработать антисептиком без спирта\n' +
    '• Нанести крем для заживления\n' +
    '• Следить за признаками воспаления\n\n' +
    
    '⬅️ <i>Используйте кнопку "Назад" для возврата к списку вопросов</i>',
    {
      parse_mode: 'HTML',
      ...addBackToQuestionsButton()
    }
  );
});

// 5. Нужна ли коррекция?
bot.action('question_correction', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '🎨 <b>НУЖНА ЛИ КОРРЕКЦИЯ ТАТУИРОВКИ?</b>\n\n' +
    
    '📅 <b>Когда делать коррекцию:</b>\n' +
    '• <b>Через 4-8 недель</b> после нанесения\n' +
    '• После полного заживления кожи\n' +
    '• Когда проявились все недостатки\n\n' +
    
    '🔍 <b>Причины для коррекции:</b>\n' +
    '1. <b>Неравномерное заполнение</b> - пятна, пропуски\n' +
    '2. <b>Потеря цвета</b> - слишком быстрое выцветание\n' +
    '3. <b>Расплывание контуров</b> - нечеткие границы\n' +
    '4. <b>Асимметрия</b> - заметные неровности\n' +
    '5. <b>Аллергическая реакция</b> - выпадение отдельных пигментов\n\n' +
    
    '✅ <b>Нормальные явления (не требуют коррекции):</b>\n' +
    '• Легкое выцветание в первые месяцы\n' +
    '• Небольшая неравномерность тона\n' +
    '• Легкое шелушение в процессе заживления\n' +
    '• Временное помутнение цвета\n\n' +
    
    '💰 <b>Стоимость и условия:</b>\n' +
    '• Часто входит в первоначальную стоимость\n' +
    '• Обычно бесплатна при обращении к тому же мастеру\n' +
    '• Делается в более короткий сеанс\n' +
    '• Заживает быстрее оригинала\n\n' +
    
    '💡 <b>Советы перед коррекцией:</b>\n' +
    '1. Дождитесь полного заживления (минимум 1 месяц)\n' +
    '2. Обсудите с мастером все недостатки\n' +
    '3. Принесите фото свежей татуировки для сравнения\n' +
    '4. Уточните, какие пигменты использовались\n' +
    '5. Обсудите возможные изменения дизайна\n\n' +
    
    '⚠️ <b>Когда коррекция не поможет:</b>\n' +
    '• Сильное расплывание из-за неправильного ухода\n' +
    '• Шрамы от инфекции или содранных корочек\n' +
    '• Аллергия на определенные пигменты\n' +
    '• Очень глубокая или очень поверхностная работа\n\n' +
    
    '🔄 <b>Альтернативы коррекции:</b>\n' +
    '• Лазерное удаление и новое тату\n' +
    '• Перекрытие другой татуировкой\n' +
    '• Доработка в другом стиле\n' +
    '• Художественная ретушь\n\n' +
    
    '⬅️ <i>Используйте кнопку "Назад" для возврата к списку вопросов</i>',
    {
      parse_mode: 'HTML',
      ...addBackToQuestionsButton()
    }
  );
});

// 6. Какие кремы использовать?
bot.action('question_creams', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '💊 <b>КАКИЕ КРЕМЫ ИСПОЛЬЗОВАТЬ ДЛЯ УХОДА?</b>\n\n' +
    
    '🌟 <b>Рекомендованные средства:</b>\n\n' +
    
    '🩹 <b>Для первых 3 дней:</b>\n' +
    '• <b>Бепантен</b> (декспантенол 5%) - заживление, снятие воспаления\n' +
    '• <b>Пантенол спрей</b> - удобное нанесение, не требует втирания\n' +
    '• <b>Д-Пантенол</b> - аналогичное действие, часто дешевле\n\n' +
    '• <b style="color: #e40d0d;">Метилурациловая мази</b> - более дешёвый аналог для заживления и снятия воспаления\n'+
    
    '💧 <b>Для дней 3-14:</b>\n' +
    '• <b>La Roche-Posay Cicaplast Baume B5</b> - восстановление барьера кожи\n' +
    '• <b>Avene Cicalfate+</b> - успокаивает, уменьшает покраснение\n' +
    '• <b>Bioderma Cicabio</b> - для чувствительной кожи, гипоаллергенный\n\n' +
    
    '🌿 <b>Натуральные средства (после консультации):</b>\n' +
    '• <b>Мазь с календулой</b> - противовоспалительное, заживляющее\n' +
    '• <b>Облепиховое масло</b> - регенерация, только после 2 недель\n' +
    '• <b>Кокосовое масло</b> - увлажнение, противомикробное действие\n\n' +
    
    '🚫 <b>Запрещенные средства:</b>\n' +
    '• Спиртосодержащие лосьоны\n' +
    '• Гормональные мази без назначения врача\n' +
    '• Кремы с ретиноидами (Retin-A)\n' +
    '• Средства с сильными отдушками\n' +
    '• Вазелин и жирные мази (забивают поры)\n\n' +
    
    '💡 <b>Правила нанесение:</b>\n' +
    '1. Наносить на чистую сухую кожу\n' +
    '2. Количество - с горошину на ладонь\n' +
    '3. Распределять тонким равномерным слоем\n' +
    '4. Не втирать, а аккуратно похлопывать\n' +
    '5. Дать впитаться 15-20 минут\n' +
    '6. Повторять 2-3 раза в день\n\n' +
    
    '⚠️ <b>Признаки неподходящего средства:</b>\n' +
    '• Усиление покраснения\n' +
    '• Появление сыпи или волдырей\n' +
    '• Усиление зуда\n' +
    '• Ощущение жжения\n' +
    '• Липкость или жирный блеск\n\n' +
    
    '🛒 <b>Где покупать:</b>\n' +
    '• Аптеки (оригинальные средства)\n' +
    '• Официальные магазины косметики\n' +
    '• У проверенных продавцов\n' +
    '• Избегайте рынков и сомнительных сайтов\n\n' +
    
    '⬅️ <i>Используйте кнопку "Назад" для возврата к списку вопросов</i>',
    {
      parse_mode: 'HTML',
      ...addBackToQuestionsButton()
    }
  );
});

// 7. Связаться с поддержкой - ИСПРАВЛЕННЫЙ ВАРИАНТ
bot.action('question_support', async (ctx) => {
  await ctx.answerCbQuery();
  
  let saved = false;
  // Сохраняем запрос в базу данных
  if (ctx.db && ctx.user) {
    try {
      await ctx.db.User.updateOne(
        { telegramId: ctx.from.id },
        {
          $push: {
            questions: {
              question: 'Запрос на связь с поддержкой',
              date: new Date(),
              status: 'pending'
            }
          }
        }
      );
      saved = true;
      console.log(`✅ Вопрос поддержки сохранен для пользователя ${ctx.from.id}`);
    } catch (error) {
      console.error('❌ Ошибка при сохранении запроса поддержки:', error);
    }
  }
  
  await ctx.editMessageText(
    '📞 <b>СВЯЗЬ С ПОДДЕРЖКОЙ</b>\n\n' +
    
    '🕒 <b>Время работы поддержки:</b>\n' +
    '• Понедельник - Пятница: 00:09 - 18:00\n' +
    '• Суббота: 00:09 - 18:00\n' +
    '• Воскресенье: Только по записи\n\n' +
    
    '📧 <b>Способы связи:</b>\n' +
    '• <b>Telegram:</b> @tattoo_care_bot\n' +
    // '• <b>Email:</b> support@tattoocare.ru\n' 
    '• <b>Телефон:</b> +7 (771) 194-16-82\n\n' +
    
    '💡 <b>Что указать при обращении:</b>\n' +
    '1. Ваш ID пользователя: ' + ctx.from.id + '\n' +
    '2. Дату нанесения татуировки (если знаете)\n' +
    '3. Подробное описание проблемы\n' +
    '4. Фотографии (если возможно)\n' +
    '5. Какие средства ухода используете\n\n' +
    
    '⚠️ <b>Важно:</b>\n' +
    '• Для экстренных случаев обращайтесь к врачу!\n' +
    '• Бот не заменяет медицинскую консультацию\n' +
    '• При серьезных симптомах вызывайте скорую\n\n' +
    
    (saved ? '✅ <b>Ваш запрос на связь с поддержкой сохранен.</b>\n' : '❌ <b>Не удалось сохранить запрос.</b>\n') +
    'Мы свяжемся с вами в течение 24 часов в рабочее время.\n\n' +
    
    '⬅️ <i>Используйте кнопку "Назад" для возврата к списку вопросов</i>',
    {
      parse_mode: 'HTML',
      ...addBackToQuestionsButton()
    }
  );
});

// 8. Задать свой вопрос
bot.action('question_custom', async (ctx) => {
  await ctx.answerCbQuery();
  
  // Устанавливаем стадию для ожидания вопроса
  if (ctx.db && ctx.user) {
    await ctx.db.User.updateOne(
      { telegramId: ctx.from.id },
      { $set: { stage: 'awaiting_question' } }
    );
  }
  
  await ctx.editMessageText(
    '💬 <b>ЗАДАТЬ СВОЙ ВОПРОС</b>\n\n' +
    
    '📝 <b>Опишите вашу проблему или вопрос:</b>\n\n' +
    
    '💡 <b>Что важно указать:</b>\n' +
    '1. Когда сделана татуировка\n' +
    '2. Локализация на теле\n' +
    '3. Какие симптомы беспокоят\n' +
    '4. Какой уход применяете\n' +
    '5. Были ли подобные проблемы раньше\n\n' +
    
    '⚠️ <b>Помните:</b>\n' +
    '• Ответ может занять до 24 часов\n' +
    '• Для экстренных случаев - к врачу!\n' +
    '• Можно прикрепить фото (отправьте отдельным сообщением)\n\n' +
    
    '❌ <b>Для отмены напишите "Отмена"</b>\n\n' +
    
    '⬅️ <i>Используйте кнопку "Назад" для возврата к списку вопросов</i>',
    {
      parse_mode: 'HTML',
      ...addBackToQuestionsButton()
    }
  );
});

// Напоминания
bot.hears('⏱ Мои напоминания', async (ctx) => {
  await ctx.reply(
    '⏰ <b>Напоминания по уходу:</b>\n\n' +
    'Я могу напоминать тебе о важных процедурах.',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('⏱ Каждые 3 часа', 'reminder_3h'),
        Markup.button.callback('🌅 Утром/вечером', 'reminder_12h')
      ],
      [
        Markup.button.callback('📅 3 раза в день', 'reminder_8h'),
        Markup.button.callback('🔕 Выключить', 'reminder_off')
      ],
      [
        Markup.button.callback('📋 Мои напоминания', 'reminder_list')
      ]
    ]).resize()
  );
});

// Обработчики для напоминаний (заглушки)
bot.action('reminder_3h', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('✅ Напоминания установлены на каждые 3 часа!');
});

bot.action('reminder_12h', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('✅ Напоминания установлены на утро и вечер!');
});

bot.action('reminder_8h', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('✅ Напоминания установлены 3 раза в день!');
});

bot.action('reminder_off', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('🔕 Напоминания выключены.');
});

bot.action('reminder_list', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('📋 У вас пока нет активных напоминаний.');
});

// ========== ОБРАБОТЧИКИ ДЛЯ ЛОГА ДЕЙСТВИЙ ==========

// 8. Просмотр лога действий
bot.action('admin_access_log', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }
  
  addToSystemLog(`Админ ${ctx.from.id} открыл лог действий`, 'ADMIN_ACTION');
  
  await showAccessLog(ctx);
});

// 9. Пагинация лога (регулярное выражение)
bot.action(/admin_access_log_page_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) return;
  
  const page = parseInt(ctx.match[1]);
  await showAccessLog(ctx, page);
});

// 10. Обновление лога (регулярное выражение)
bot.action(/admin_access_log_refresh_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) return;
  
  const page = parseInt(ctx.match[1]);
  await showAccessLog(ctx, page, true);
});

// 11. Подтверждение очистки лога
bot.action('admin_access_log_clear_confirm', async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) return;
  
  await confirmClearAccessLog(ctx);
});

// 12. Очистка лога
bot.action('admin_access_log_clear', async (ctx) => {
  await clearAccessLog(ctx);
});

bot.action('appointment_consult', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '📅 Запись на онлайн-консультацию\n\n' +
    'Пожалуйста, введите желаемую дату в формате ДД.ММ.ГГГГ (например, 15.05.2025):\n'+
    ' ❌Напишите "Отмена" для отмены записи.',
    { parse_mode: 'HTML' }
  );
  await ctx.db.User.updateOne(
    { telegramId: ctx.from.id },
    { 
      $set: { 
        stage: 'awaiting_appointment_date',
        appointmentTemp: { type: 'consultation' }
      } 
    }
  );
});

bot.action('appointment_tattoo', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '🎨 Запись на тату\n\n' +
    'Пожалуйста, введите желаемую дату в формате ДД.ММ.ГГГГ (например, 15.05.2025):\n'+
    ' ❌ Напишите "Отмена" для отмены записи.',
    { parse_mode: 'HTML' }
  );
  await ctx.db.User.updateOne(
    { telegramId: ctx.from.id },
    { 
      $set: { 
        stage: 'awaiting_appointment_date',
        appointmentTemp: { type: 'tattoo' }
      } 
    }
  );
});

// Лазерное удаление (начало записи)
bot.action('appointment_laser', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '🔬 Запись на лазерное удаление\n\n' +
    'Пожалуйста, введите желаемую дату в формате ДД.ММ.ГГГГ (например, 15.05.2025):\n' +
    '❌ Напишите "Отмена" для отмены записи.',
    { parse_mode: 'HTML' }
  );
  await ctx.db.User.updateOne(
    { telegramId: ctx.from.id },
    { 
      $set: { 
        stage: 'awaiting_appointment_date',
        appointmentTemp: { type: 'laser' }
      } 
    }
  );
});

bot.action('appointment_back', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    'Выберите действие:',
    Markup.keyboard([
      ['🩹 Уход за тату', '⚠️ Возможные проблемы'],
      ['🚫 Что нельзя делать', '⏱ Мои напоминания'],
      ['📊 Статус заживления', '❓ Задать вопрос'],
      ['📅 Запись', '🔬 Лазерное удаление']
    ]).resize()
  );
});

// ========== ОБРАБОТЧИК ДЛЯ ТЕКСТОВЫХ СООБЩЕНИЙ (ПОСЛЕ КОМАНД) ==========
bot.on('text', async (ctx) => {
  // Пропускаем команды (они начинаются с /)
  if (ctx.message.text.startsWith('/')) {
    return; // Пусть команды обрабатываются своими обработчиками
  }
  
   // Проверяем, ждем ли мы текст для рассылки
  if (ctx.user && ctx.user.stage === 'awaiting_broadcast_text') {
    const userText = ctx.message.text;
    
    // Проверяем отмену
    if (userText.toLowerCase() === 'отмена') {
      await ctx.db.User.updateOne(
        { telegramId: ctx.from.id },
        { $set: { stage: 'main_menu' } }
      );
      
      await ctx.reply(
        '❌ Рассылка отменена.\n\n' +
        'Возвращаю в главное меню админ-панели.',
        Markup.inlineKeyboard([
          [Markup.button.callback('📢 Вернуться к рассылке', 'admin_broadcast')],
          [Markup.button.callback('👑 Админ-панель', 'admin_back')]
        ])
      );
      return;
    }
    
    // Запускаем рассылку
    await ctx.db.User.updateOne(
      { telegramId: ctx.from.id },
      { $set: { stage: 'main_menu' } }
    );
    
    await startBroadcastToAll(ctx, userText);
    return;
  }

  // Проверяем, ждем ли мы текст для рассылки ПОЛЬЗОВАТЕЛЯМ С ТАТУ
  if (ctx.user && ctx.user.stage === 'awaiting_broadcast_tattoo_text') {
    const userText = ctx.message.text;
    
    // Проверяем отмену
    if (userText.toLowerCase() === 'отмена') {
      await ctx.db.User.updateOne(
        { telegramId: ctx.from.id },
        { $set: { stage: 'main_menu' } }
      );
      
      await ctx.reply(
        '❌ Рассылка пользователям с тату отменена.\n\n' +
        'Возвращаю в главное меню админ-панели.',
        Markup.inlineKeyboard([
          [Markup.button.callback('📢 Вернуться к рассылке', 'admin_broadcast')],
          [Markup.button.callback('👑 Админ-панель', 'admin_back')]
        ])
      );
      return;
    }
    
    // Запускаем рассылку пользователям с тату
    await ctx.db.User.updateOne(
      { telegramId: ctx.from.id },
      { $set: { stage: 'main_menu' } }
    );
    
    try {
      await startBroadcastToTattooUsers(ctx, userText);
    } catch (error) {
      console.error('Ошибка при запуске рассылки пользователям с тату:', error);
      await ctx.reply(`❌ Ошибка при запуске рассылки: ${error.message}`);
    }
    return;
  }

  // Проверяем, ждем ли мы текст для рассылки ПОЛЬЗОВАТЕЛЯМ С ВОПРОСАМИ
  if (ctx.user && ctx.user.stage === 'awaiting_broadcast_questions_text') {
    const userText = ctx.message.text;
    
    // Проверяем отмену
    if (userText.toLowerCase() === 'отмена') {
      await ctx.db.User.updateOne(
        { telegramId: ctx.from.id },
        { $set: { stage: 'main_menu' } }
      );
      
      await ctx.reply(
        '❌ Рассылка пользователям с вопросами отменена.\n\n' +
        'Возвращаю в главное меню админ-панели.',
        Markup.inlineKeyboard([
          [Markup.button.callback('📢 Вернуться к рассылке', 'admin_broadcast')],
          [Markup.button.callback('👑 Админ-панель', 'admin_back')]
        ])
      );
      return;
    }
    
    // Запускаем рассылку пользователям с вопросами
    await ctx.db.User.updateOne(
      { telegramId: ctx.from.id },
      { $set: { stage: 'main_menu' } }
    );
    
    try {
      await startBroadcastToUsersWithQuestions(ctx, userText);
    } catch (error) {
      console.error('Ошибка при запуске рассылки пользователям с вопросами:', error);
      await ctx.reply(`❌ Ошибка при запуске рассылки: ${error.message}`);
    }
    return;
  }

  // Проверяем, ждем ли мы вопрос от пользователя
  if (ctx.user && ctx.user.stage === 'awaiting_question') {
    const userText = ctx.message.text;
    
    // Проверяем, не отмена ли это
    if (userText.toLowerCase() === 'отмена') {
      // Возвращаем пользователя в главное меню
      await ctx.db.User.updateOne(
        { telegramId: ctx.from.id },
        { $set: { stage: 'main_menu' } }
      );
      
      await ctx.reply(
        '❌ Ввод вопроса отменен.\n\n' +
        'Выберите что вас интересует:',
        Markup.keyboard([
          ['🩹 Уход за тату', '⚠️ Возможные проблемы'],
          ['🚫 Что нельзя делать', '⏱ Мои напоминания'],
          ['📊 Статус заживления', '❓ Задать вопрос'],
          ['📅 Запись']  // новая кнопка
        ]).resize()
      );
      return;
    }
    
    // Сохраняем вопрос в базу данных
    try {
      await ctx.db.User.updateOne(
        { telegramId: ctx.from.id },
        {
          $push: {
            questions: {
              question: userText,
              date: new Date(),
              status: 'pending'
            }
          },
          $set: { stage: 'main_menu' }
        }
      );
      
      await ctx.replyWithHTML(
        '✅ <b>Ваш вопрос сохранен!</b>\n\n' +
        '📝 <b>Ваш вопрос:</b>\n' +
        userText + '\n\n' +
        '⏳ <b>Мы ответим вам в течение 24 часов в рабочее время.</b>\n\n' +
        '🕒 <b>Время работы поддержки:</b>\n' +
        'Пн-Пт: 10:00-19:00\n' +
        'Сб: 11:00-16:00\n' +
        'Вс: выходной\n\n' +
        '📧 <b>Для срочных вопросов:</b> @tattoo_support_bot\n\n' +
        'Теперь выберите что вас интересует:',
        Markup.keyboard([
          ['🩹 Уход за тату', '⚠️ Возможные проблемы'],
          ['🚫 Что нельзя делать', '⏱ Мои напоминания'],
          ['📊 Статус заживления', '❓ Задать вопрос'],
          ['📅 Запись']  // новая кнопка
        ]).resize()
      );
      
    } catch (error) {
      console.error('Ошибка при сохранении вопроса:', error);
      await ctx.reply(
        '❌ Произошла ошибка при сохранении вопроса. Попробуйте позже.',
        Markup.keyboard([
          ['🩹 Уход за тату', '⚠️ Возможные проблемы'],
          ['🚫 Что нельзя делать', '⏱ Мои напоминания'],
          ['📊 Статус заживления', '❓ Задать вопрос'],
          ['📅 Запись']  // новая кнопка
        ]).resize()
      );
    }
  }

  // Проверяем, ждем ли мы текст для рассылки АКТИВНЫМ ПОЛЬЗОВАТЕЛЯМ
  if (ctx.user && ctx.user.stage === 'awaiting_broadcast_active_text') {
    const userText = ctx.message.text;
    
    // Проверяем отмену
    if (userText.toLowerCase() === 'отмена') {
      await ctx.db.User.updateOne(
        { telegramId: ctx.from.id },
        { $set: { stage: 'main_menu' } }
      );
      
      await ctx.reply(
        '❌ Рассылка активным пользователям отменена.',
        Markup.inlineKeyboard([
          [Markup.button.callback('📢 Вернуться к рассылке', 'admin_broadcast')],
          [Markup.button.callback('👑 Админ-панель', 'admin_back')]
        ])
      );
      return;
    }
    
    // Запускаем рассылку активным пользователям
    await ctx.db.User.updateOne(
      { telegramId: ctx.from.id },
      { $set: { stage: 'main_menu' } }
    );
    
    try {
      await startBroadcastToActiveUsers(ctx, userText);
    } catch (error) {
      console.error('Ошибка при запуске рассылки активным пользователям:', error);
      await ctx.reply(`❌ Ошибка: ${error.message}`);
    }
    return;
  }

    // Проверяем, ждем ли мы шаблон от пользователя
  if (ctx.user && ctx.user.stage === 'awaiting_template') {
    const userText = ctx.message.text;
    
    // Проверяем отмену
    if (userText.toLowerCase() === 'отмена') {
      await ctx.db.User.updateOne(
        { telegramId: ctx.from.id },
        { $set: { stage: 'main_menu' } }
      );
      
      await ctx.reply(
        '❌ Создание шаблона отменено.\n\n' +
        'Возвращаю в меню шаблонов.',
        Markup.inlineKeyboard([
          [Markup.button.callback('📝 Шаблоны ответов', 'admin_settings_templates')]
        ])
      );
      return;
    }
    
    // Парсим шаблон
    try {
      const lines = userText.split('\n');
      let title = '';
      let category = 'общее';
      let tags = [];
      let text = '';
      
      lines.forEach(line => {
        const lowerLine = line.toLowerCase();
        if (lowerLine.startsWith('заголовок:')) {
          title = line.substring('заголовок:'.length).trim();
        } else if (lowerLine.startsWith('категория:')) {
          category = line.substring('категория:'.length).trim();
        } else if (lowerLine.startsWith('теги:')) {
          const tagsStr = line.substring('теги:'.length).trim();
          tags = tagsStr.split(',').map(tag => tag.trim());
        } else if (lowerLine.startsWith('текст:')) {
          text = line.substring('текст:'.length).trim();
        } else if (title && !text) {
          // Если уже есть заголовок, но текст еще не начался
          // и эта строка не является специальной, добавляем к тексту
          text += (text ? '\n' : '') + line;
        }
      });
      
      // Проверяем обязательные поля
      if (!title || !text) {
        await ctx.reply(
          '❌ <b>Неверный формат шаблона</b>\n\n' +
          'Шаблон должен содержать как минимум заголовок и текст.\n\n' +
          'Попробуйте снова или отправьте "отмена" для отмены.',
          { parse_mode: 'HTML' }
        );
        return;
      }
      
      // Создаем новый шаблон
      if (!systemCache.templates) {
        systemCache.templates = { templates: [], categories: [], lastUpdated: new Date() };
      }
      
      const newTemplate = {
        id: systemCache.templates.templates.length > 0 ? 
            Math.max(...systemCache.templates.templates.map(t => t.id)) + 1 : 1,
        title: title,
        text: text,
        category: category,
        tags: tags,
        usageCount: 0,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      
      // Добавляем категорию, если ее нет
      if (!systemCache.templates.categories.includes(category)) {
        systemCache.templates.categories.push(category);
      }
      
      systemCache.templates.templates.push(newTemplate);
      systemCache.templates.lastUpdated = new Date();
      
      await ctx.db.User.updateOne(
        { telegramId: ctx.from.id },
        { $set: { stage: 'main_menu' } }
      );
      
      await ctx.replyWithHTML(
        '✅ <b>Шаблон успешно создан!</b>\n\n' +
        `<b>Заголовок:</b> ${title}\n` +
        `<b>Категория:</b> ${category}\n` +
        `<b>Теги:</b> ${tags.join(', ') || 'нет'}\n` +
        `<b>Текст:</b>\n${text.substring(0, 200)}${text.length > 200 ? '...' : ''}\n\n` +
        `<b>ID шаблона:</b> ${newTemplate.id}\n\n` +
        'Теперь вы можете использовать этот шаблон для быстрых ответов.',
        Markup.inlineKeyboard([
          [Markup.button.callback('📝 Все шаблоны', 'admin_settings_templates')]
        ])
      );
      
      addToSystemLog(`Админ ${ctx.from.id} создал новый шаблон: ${title}`, 'ADMIN_ACTION');
      
    } catch (error) {
      console.error('Ошибка при создании шаблона:', error);
      await ctx.reply(
        '❌ Произошла ошибка при создании шаблона. Попробуйте еще раз или отправьте "отмена".'
      );
    }
    return;
  }

  // Проверяем, ждем ли мы добавление категории
  if (ctx.user && ctx.user.stage === 'awaiting_category_add') {
    const categoryName = ctx.message.text.trim();
    
    // Проверяем отмену
    if (categoryName.toLowerCase() === 'отмена') {
      await ctx.db.User.updateOne(
        { telegramId: ctx.from.id },
        { $set: { stage: 'main_menu' } }
      );
      
      await ctx.reply(
        '❌ Добавление категории отменено.',
        Markup.inlineKeyboard([
          [Markup.button.callback('📁 Категории', 'admin_templates_categories')]
        ])
      );
      return;
    }
    
    if (!categoryName) {
      await ctx.reply('❌ Название категории не может быть пустым. Попробуйте еще раз.');
      return;
    }
    
    try {
      if (!systemCache.templates) {
        systemCache.templates = { templates: [], categories: [], lastUpdated: new Date() };
      }
      
      // Проверяем, существует ли уже такая категория
      if (systemCache.templates.categories.includes(categoryName)) {
        await ctx.reply(
          `❌ Категория "${categoryName}" уже существует.`,
          Markup.inlineKeyboard([
            [Markup.button.callback('📁 Категории', 'admin_templates_categories')]
          ])
        );
        return;
      }
      
      // Добавляем категорию
      systemCache.templates.categories.push(categoryName);
      systemCache.templates.lastUpdated = new Date();
      
      await ctx.db.User.updateOne(
        { telegramId: ctx.from.id },
        { $set: { stage: 'main_menu' } }
      );
      
      await ctx.reply(
        `✅ Категория "${categoryName}" успешно добавлена!\n\n` +
        `Теперь вы можете создавать шаблоны в этой категории.`,
        Markup.inlineKeyboard([
          [Markup.button.callback('📁 Категории', 'admin_templates_categories')],
          [Markup.button.callback('➕ Создать шаблон', 'admin_template_create')]
        ])
      );
      
      addToSystemLog(`Админ ${ctx.from.id} добавил новую категорию: ${categoryName}`, 'ADMIN_ACTION');
      
    } catch (error) {
      console.error('Ошибка при добавлении категории:', error);
      await ctx.reply('❌ Произошла ошибка. Попробуйте еще раз.');
    }
    return;
  }

  if (ctx.user?.stage === 'awaiting_admin_id') {
    const text = ctx.message.text.trim();
    
    // Проверка на отмену
    if (text.toLowerCase() === 'отмена') {
      await ctx.reply('❌ Добавление администратора отменено');
      await ctx.db.User.updateOne(
        { telegramId: ctx.from.id },
        { $set: { stage: null } }
      );
      await showAccessSettings(ctx);
      return;
    }
    
    // Проверяем, что введено число
    const newAdminId = parseInt(text);
    if (isNaN(newAdminId) || newAdminId <= 0) {
      await ctx.reply('❌ Неверный формат ID. Введите числовой Telegram ID.');
      return;
    }
    
    // Проверяем, не является ли уже администратором
    if (systemCache.accessSettings?.admins?.some(admin => admin.id === newAdminId)) {
      await ctx.reply('❌ Этот пользователь уже является администратором.');
      await ctx.db.User.updateOne(
        { telegramId: ctx.from.id },
        { $set: { stage: null } }
      );
      await showAccessSettings(ctx);
      return;
    }
    
    // Проверяем, есть ли пользователь в базе
    try {
      const userInDb = await ctx.db.User.findOne({ telegramId: newAdminId });
      
      if (!userInDb) {
        await ctx.reply('⚠️ Пользователь с таким ID не найден в базе данных. Убедитесь, что пользователь начал диалог с ботом.');
        return;
      }
      
      // Добавляем нового администратора
      const newAdmin = {
        id: newAdminId,
        name: userInDb.firstName || `Администратор ${newAdminId}`,
        username: userInDb.username,
        addedAt: new Date(),
        addedBy: ctx.from.id,
        permissions: {
          fullAccess: false,
          canManageUsers: true,
          canManageQuestions: true,
          canManageSettings: false,
          canSendBroadcasts: false,
          canViewAnalytics: true
        }
      };
      
      if (!systemCache.accessSettings) {
        systemCache.accessSettings = {
          admins: [],
          maxAdmins: 5,
          lastUpdated: new Date()
        };
      }
      
      systemCache.accessSettings.admins.push(newAdmin);
      systemCache.accessSettings.lastUpdated = new Date();

                  // Сохраняем в базу данных
      await ctx.db.User.updateOne(
        { telegramId: newAdminId },
        {
          $set: {
            isAdmin: true,
            adminPermissions: newAdmin.permissions
          }
        }
      );
      
      addToSystemLog(`Админ ${ctx.from.id} добавил нового администратора ${newAdminId}`, 'ADMIN_ACTION');
      
      await ctx.reply(`✅ Пользователь ${newAdmin.name} (ID: ${newAdminId}) добавлен как администратор с базовыми правами.`);
      
      await ctx.db.User.updateOne(
        { telegramId: ctx.from.id },
        { $set: { stage: null } }
      );
      
      await showAccessSettings(ctx);
      
    } catch (error) {
      console.error('Ошибка при добавлении администратора:', error);
      await ctx.reply('❌ Ошибка при добавлении администратора. Попробуйте снова.');
    }
    
    return;
  }
    // Обработка отмены на любом этапе записи
  if (ctx.user && ctx.user.stage && ctx.user.stage.startsWith('awaiting_appointment')) {
    if (ctx.message.text.toLowerCase() === 'отмена') {
      await ctx.db.User.updateOne(
        { telegramId: ctx.from.id },
        { $set: { stage: 'main_menu' }, $unset: { appointmentTemp: 1 } }
      );
      await ctx.reply(
        '❌ Запись отменена.',
        Markup.keyboard([
          ['🩹 Уход за тату', '⚠️ Возможные проблемы'],
          ['🚫 Что нельзя делать', '⏱ Мои напоминания'],
          ['📊 Статус заживления', '❓ Задать вопрос'],
          ['📅 Запись']
        ]).resize()
      );
      return;
    }
  }

  // Этап 1: ожидание даты
  if (ctx.user && ctx.user.stage === 'awaiting_appointment_date') {
    const dateStr = ctx.message.text.trim();
    const datePattern = /^(\d{2})\.(\d{2})\.(\d{4})$/;
    const match = dateStr.match(datePattern);
    if (!match) {
      await ctx.reply('❌ Неверный формат даты. Введите дату в формате ДД.ММ.ГГГГ (например, 15.05.2025):');
      return;
    }
    const day = parseInt(match[1]);
    const month = parseInt(match[2]) - 1;
    const year = parseInt(match[3]);
    const date = new Date(year, month, day);
    if (isNaN(date.getTime())) {
      await ctx.reply('❌ Некорректная дата. Попробуйте еще раз:');
      return;
    }
    await ctx.db.User.updateOne(
      { telegramId: ctx.from.id },
      { 
        $set: { 
          stage: 'awaiting_appointment_time',
          'appointmentTemp.date': date 
        } 
      }
    );
    await ctx.reply('⏰ Введите желаемое время в формате ЧЧ:ММ (например, 14:30):');
    return;
  }

  // Этап 2: ожидание времени
  if (ctx.user && ctx.user.stage === 'awaiting_appointment_time') {
    const timeStr = ctx.message.text.trim();
    const timePattern = /^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/;
    if (!timePattern.test(timeStr)) {
      await ctx.reply('❌ Неверный формат времени. Введите время в формате ЧЧ:ММ (например, 14:30):');
      return;
    }
    await ctx.db.User.updateOne(
      { telegramId: ctx.from.id },
      { 
        $set: { 
          stage: 'awaiting_appointment_comment',
          'appointmentTemp.time': timeStr 
        } 
      }
    );
    await ctx.reply('💬 Напишите комментарий к записи (или отправьте "нет", если комментария нет):');
    return;
  }

  // Этап 3: ожидание комментария
  if (ctx.user && ctx.user.stage === 'awaiting_appointment_comment') {
    const comment = ctx.message.text.trim();
    const finalComment = (comment.toLowerCase() === 'нет') ? '' : comment;
    await ctx.db.User.updateOne(
      { telegramId: ctx.from.id },
      { 
        $set: { 
          stage: 'awaiting_appointment_contact',
          'appointmentTemp.comment': finalComment 
        } 
      }
    );
    await ctx.reply('📞 Укажите ваш контакт для связи (Telegram @username или номер телефона):');
    return;
  }

  // Этап 4: ожидание контакта и финальное сохранение
  if (ctx.user && ctx.user.stage === 'awaiting_appointment_contact') {
    const contact = ctx.message.text.trim();
    
    // Получаем все данные из appointmentTemp
    const user = await ctx.db.User.findOne({ telegramId: ctx.from.id });
    const temp = user.appointmentTemp;
    if (!temp || !temp.type || !temp.date || !temp.time) {
      await ctx.reply('❌ Ошибка: данные записи повреждены. Начните заново.');
      await ctx.db.User.updateOne(
        { telegramId: ctx.from.id },
        { $set: { stage: 'main_menu' }, $unset: { appointmentTemp: 1 } }
      );
      return;
    }

    const [hours, minutes] = temp.time.split(':').map(Number);
    const dateTime = new Date(temp.date);
    dateTime.setHours(hours, minutes, 0, 0);

    try {
      const appointment = new ctx.db.Appointment({
        userId: ctx.from.id,
        userName: ctx.user.firstName,
        userContact: contact,
        type: temp.type,
        date: dateTime,
        comment: temp.comment || '',
        status: 'pending'
      });
      await appointment.save();

      // Подтверждение пользователю
      await ctx.replyWithHTML(
        '✅ <b>Запись успешно создана!</b>\n\n' +
        `📅 <b>Тип:</b> ${temp.type === 'consultation' ? 'Онлайн-консультация' : 'Запись на тату'}\n` +
        `📆 <b>Дата:</b> ${dateTime.toLocaleDateString('ru-RU')}\n` +
        `⏰ <b>Время:</b> ${dateTime.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}\n` +
        `💬 <b>Комментарий:</b> ${temp.comment || '—'}\n` +
        `📞 <b>Контакт:</b> ${contact}\n\n` +
        `Мы свяжемся с вами для подтверждения.`,
        Markup.keyboard([
          ['🩹 Уход за тату', '⚠️ Возможные проблемы'],
          ['🚫 Что нельзя делать', '⏱ Мои напоминания'],
          ['📊 Статус заживления', '❓ Задать вопрос'],
          ['📅 Запись']
        ]).resize()
      );

      // Уведомление всем администраторам
      if (systemCache.accessSettings && systemCache.accessSettings.admins) {
        for (const admin of systemCache.accessSettings.admins) {
          try {
            await ctx.telegram.sendMessage(
              admin.id,
              `🔔 <b>Новая запись!</b>\n\n` +
              `👤 <b>Пользователь:</b> ${ctx.user.firstName} (ID: ${ctx.from.id})\n` +
              `📞 <b>Контакт:</b> ${contact}\n` +
              `📋 <b>Тип:</b> ${
                temp.type === 'consultation' ? 'Онлайн-консультация' :
                temp.type === 'tattoo' ? 'Запись на тату' :
                temp.type === 'laser' ? 'Лазерное удаление' : temp.type
              }\n` +
              `📅 <b>Дата:</b> ${dateTime.toLocaleDateString('ru-RU')}\n` +
              `⏰ <b>Время:</b> ${dateTime.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}\n` +
              `💬 <b>Комментарий:</b> ${temp.comment || '—'}\n` +
              `🆔 <b>ID записи:</b> ${appointment._id}`,
              { parse_mode: 'HTML' }
            );
          } catch (e) {
            console.error(`Не удалось отправить уведомление админу ${admin.id}:`, e);
          }
        }
      }

      // Очищаем временные данные
      await ctx.db.User.updateOne(
        { telegramId: ctx.from.id },
        { $set: { stage: 'main_menu' }, $unset: { appointmentTemp: 1 } }
      );
    } catch (error) {
      console.error('Ошибка при сохранении записи:', error);
      await ctx.reply('❌ Произошла ошибка при сохранении записи. Попробуйте позже.');
      await ctx.db.User.updateOne(
        { telegramId: ctx.from.id },
        { $set: { stage: 'main_menu' }, $unset: { appointmentTemp: 1 } }
      );
    }
    return;
  }

});

// Глобальный обработчик ошибок для всех обработчиков
bot.catch((err, ctx) => {
  console.error(`💥 Глобальная ошибка в обновлении ${ctx.updateType}:`, err);
  
  // Пытаемся отправить сообщение об ошибке
  try {
    if (ctx.updateType === 'callback_query') {
      ctx.answerCbQuery('❌ Произошла ошибка, попробуйте позже');
    } else if (ctx.updateType === 'message') {
      ctx.reply('❌ Произошла ошибка при обработке сообщения');
    }
  } catch (e) {
    console.error('Не удалось отправить сообщение об ошибке:', e);
  }
});


// ========== ОБРАБОТКА НЕИЗВЕСТНЫХ КОМАНД И СООБЩЕНИЙ ==========
bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  
  // Пропускаем команды (они начинаются с /)
  if (text.startsWith('/')) {
    // Проверяем, не является ли это одной из известных команд
    const knownCommands = [
      'start', 'myquestions', 'debuguser', 'debug', 
      'stats', 'setdate', 'admin', 'users', 'broadcast'
    ];
    
    const command = text.substring(1).split(' ')[0].toLowerCase();
    
    if (!knownCommands.includes(command)) {
      console.log(`❓ Неизвестная команда от ${ctx.from.id}: ${text}`);
      
      await ctx.replyWithHTML(
        `❓ <b>Неизвестная команда:</b> ${text}\n\n` +
        `📋 <b>Доступные команды:</b>\n` +
        `/start - Запустить бота\n` +
        `/myquestions - Мои вопросы\n` +
        `/debuguser - Отладка пользователя\n` +
        `/debug - Информация о системе\n` +
        `/stats - Статистика (админ)\n` +
        `/admin - Панель администратора\n` +
        `/setdate - Установить дату татуировки\n\n` +
        `🔍 <b>Или воспользуйтесь кнопками меню</b>`
      );
    }
    return;
  }

  // Проверяем, ждем ли мы вопрос от пользователя
  if (ctx.user && ctx.user.stage === 'awaiting_question') {
    await handleUserQuestion(ctx, text);
    return;
  }
  
  // Если это просто текст (не команда и не ожидаем вопрос)
  // Проверяем, является ли это ответом на что-то из меню
  if (![
    '📅 Сегодня', '📅 Вчера', '🚫 Пропустить',
    '🩹 Уход за тату', '⚠️ Возможные проблемы',
    '🚫 Что нельзя делать', '⏱ Мои напоминания',
    '📊 Статус заживления', '❓ Задать вопрос'
  ].includes(text)) {
    
    console.log(`💬 Простое сообщение от ${ctx.from.id}: ${text.substring(0, 50)}...`);
    
    // Если пользователь в главном меню
    if (ctx.user && ctx.user.stage === 'main_menu') {
      await ctx.replyWithHTML(
        `💬 <b>Я получил ваше сообщение:</b>\n"${text.substring(0, 200)}"\n\n` +
        `Для общения со мной используйте кнопки меню или команды.\n` +
        `Если у вас есть вопрос о татуировке, нажмите "❓ Задать вопрос"\n\n` +
        `<b>Доступные команды:</b>\n` +
        `/start - Перезапустить бота\n` +
        `/myquestions - Посмотреть мои вопросы\n` +
        `/setdate - Установить дату тату`
      );
    } else {
      // Если пользователь не в главном меню, предлагаем вернуться
      await ctx.reply(
        'Пожалуйста, воспользуйтесь кнопками меню или командами.\n\n' +
        'Для возврата в главное меню используйте /start',
        Markup.keyboard([
          ['🩹 Уход за тату', '⚠️ Возможные проблемы'],
          ['🚫 Что нельзя делать', '⏱ Мои напоминания'],
          ['📊 Статус заживления', '❓ Задать вопрос'],
          ['📅 Запись']  // новая кнопка
        ]).resize()
      );
    }
  }
});

// Обработчик для редактирования прав конкретного администратора
bot.action(/admin_access_edit_permissions_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }

  const targetAdminId = parseInt(ctx.match[1]);
  
  // Проверяем, может ли текущий администратор редактировать права
  if (!systemCache.accessSettings) {
    await ctx.answerCbQuery('❌ Настройки доступа не загружены');
    return;
  }

  const currentAdmin = systemCache.accessSettings.admins.find(a => a.id === ctx.from.id);
  if (!currentAdmin?.permissions?.fullAccess) {
    await ctx.answerCbQuery('❌ Только главный администратор может настраивать права');
    return;
  }

  // Находим целевого администратора
  const targetAdmin = systemCache.accessSettings.admins.find(a => a.id === targetAdminId);
  if (!targetAdmin) {
    await ctx.answerCbQuery('❌ Администратор не найден');
    return;
  }

  // Показываем меню редактирования прав
  await showEditPermissionsMenu(ctx, targetAdmin);
});

// Вспомогательная функция для отображения меню редактирования прав
async function showEditPermissionsMenu(ctx, admin) {
  const permissions = admin.permissions || {
    canManageUsers: false,
    canManageQuestions: false,
    canManageSettings: false,
    canSendBroadcasts: false,
    canViewAnalytics: false
  };

  const message = `🔧 <b>РЕДАКТИРОВАНИЕ ПРАВ</b>\n\n` +
    `👤 <b>Администратор:</b> ${admin.name} (ID: ${admin.id})\n` +
    `📅 <b>Добавлен:</b> ${admin.addedAt ? new Date(admin.addedAt).toLocaleDateString('ru-RU') : 'неизвестно'}\n\n` +
    `📋 <b>Текущие права:</b>\n` +
    `• 👥 Управление пользователями: ${permissions.canManageUsers ? '✅' : '❌'}\n` +
    `• ❓ Управление вопросами: ${permissions.canManageQuestions ? '✅' : '❌'}\n` +
    `• ⚙️ Управление настройками: ${permissions.canManageSettings ? '✅' : '❌'}\n` +
    `• 📢 Рассылки: ${permissions.canSendBroadcasts ? '✅' : '❌'}\n` +
    `• 📊 Просмотр аналитики: ${permissions.canViewAnalytics ? '✅' : '❌'}\n\n` +
    `💡 <b>Нажмите на право, чтобы изменить его</b>`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        `${permissions.canManageUsers ? '✅' : '❌'} 👥 Пользователи`,
        `admin_access_toggle_users_${admin.id}`
      )
    ],
    [
      Markup.button.callback(
        `${permissions.canManageQuestions ? '✅' : '❌'} ❓ Вопросы`,
        `admin_access_toggle_questions_${admin.id}`
      )
    ],
    [
      Markup.button.callback(
        `${permissions.canManageSettings ? '✅' : '❌'} ⚙️ Настройки`,
        `admin_access_toggle_settings_${admin.id}`
      )
    ],
    [
      Markup.button.callback(
        `${permissions.canSendBroadcasts ? '✅' : '❌'} 📢 Рассылки`,
        `admin_access_toggle_broadcasts_${admin.id}`
      )
    ],
    [
      Markup.button.callback(
        `${permissions.canViewAnalytics ? '✅' : '❌'} 📊 Аналитика`,
        `admin_access_toggle_analytics_${admin.id}`
      )
    ],
    [
      Markup.button.callback('✅ Предоставить все права', `admin_access_grant_all_${admin.id}`),
      Markup.button.callback('❌ Сбросить все', `admin_access_revoke_all_${admin.id}`)
    ],
    [
      Markup.button.callback('🔙 Назад к списку', 'admin_access_permissions')
    ]
  ]);

  if (ctx.updateType === 'callback_query') {
    await ctx.editMessageText(message, {
      parse_mode: 'HTML',
      ...keyboard
    });
  } else {
    await ctx.replyWithHTML(message, keyboard);
  }
}

// Обработчики для переключения отдельных прав
bot.action(/admin_access_toggle_users_(\d+)/, async (ctx) => {
  await togglePermission(ctx, ctx.match[1], 'canManageUsers');
});

bot.action(/admin_access_toggle_questions_(\d+)/, async (ctx) => {
  await togglePermission(ctx, ctx.match[1], 'canManageQuestions');
});

bot.action(/admin_access_toggle_settings_(\d+)/, async (ctx) => {
  await togglePermission(ctx, ctx.match[1], 'canManageSettings');
});

bot.action(/admin_access_toggle_broadcasts_(\d+)/, async (ctx) => {
  await togglePermission(ctx, ctx.match[1], 'canSendBroadcasts');
});

bot.action(/admin_access_toggle_analytics_(\d+)/, async (ctx) => {
  await togglePermission(ctx, ctx.match[1], 'canViewAnalytics');
});

// Универсальная функция для переключения права
async function togglePermission(ctx, adminIdStr, permissionKey) {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }

  const targetAdminId = parseInt(adminIdStr);
  
  if (!systemCache.accessSettings) return;

  const targetAdmin = systemCache.accessSettings.admins.find(a => a.id === targetAdminId);
  if (!targetAdmin) {
    await ctx.answerCbQuery('❌ Администратор не найден');
    return;
  }

  // Инициализируем объект permissions, если его нет
  if (!targetAdmin.permissions) {
    targetAdmin.permissions = {
      canManageUsers: false,
      canManageQuestions: false,
      canManageSettings: false,
      canSendBroadcasts: false,
      canViewAnalytics: false
    };
  }

  // Переключаем право
  targetAdmin.permissions[permissionKey] = !targetAdmin.permissions[permissionKey];
  targetAdmin.updatedAt = new Date();
  systemCache.accessSettings.lastUpdated = new Date();

  addToSystemLog(
    `Админ ${ctx.from.id} изменил право ${permissionKey} для администратора ${targetAdminId} на ${targetAdmin.permissions[permissionKey]}`,
    'ADMIN_ACTION'
  );
  
await ctx.db.User.updateOne(
  { telegramId: targetAdminId },
  { $set: { adminPermissions: targetAdmin.permissions } }
);
  // Обновляем меню
  await showEditPermissionsMenu(ctx, targetAdmin);
}

// Обработчик для предоставления всех прав
bot.action(/admin_access_grant_all_(\d+)/, async (ctx) => {
  await setAllPermissions(ctx, ctx.match[1], true);
});

// Обработчик для сброса всех прав
bot.action(/admin_access_revoke_all_(\d+)/, async (ctx) => {
  await setAllPermissions(ctx, ctx.match[1], false);
});

async function setAllPermissions(ctx, adminIdStr, value) {
  await ctx.answerCbQuery();
  
  const ADMIN_ID = 1427347068;
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('❌ У вас нет прав администратора');
    return;
  }

  const targetAdminId = parseInt(adminIdStr);
  
  if (!systemCache.accessSettings) return;

  const targetAdmin = systemCache.accessSettings.admins.find(a => a.id === targetAdminId);
  if (!targetAdmin) {
    await ctx.answerCbQuery('❌ Администратор не найден');
    return;
  }

  targetAdmin.permissions = {
    canManageUsers: value,
    canManageQuestions: value,
    canManageSettings: value,
    canSendBroadcasts: value,
    canViewAnalytics: value
  };
  targetAdmin.updatedAt = new Date();
  systemCache.accessSettings.lastUpdated = new Date();
    // После изменения permissions:
  await ctx.db.User.updateOne(
    { telegramId: targetAdminId },
    { $set: { adminPermissions: targetAdmin.permissions } }
  );
  addToSystemLog(
    `Админ ${ctx.from.id} ${value ? 'предоставил все права' : 'сбросил все права'} для администратора ${targetAdminId}`,
    'ADMIN_ACTION'
  );

  await showEditPermissionsMenu(ctx, targetAdmin);
}

// Функция обработки вопроса пользователя
async function handleUserQuestion(ctx, userText) {
  // Проверяем, не отмена ли это
  if (userText.toLowerCase() === 'отмена') {
    // Возвращаем пользователя в главное меню
    await ctx.db.User.updateOne(
      { telegramId: ctx.from.id },
      { $set: { stage: 'main_menu' } }
    );
    
    await ctx.reply(
      '❌ Ввод вопроса отменен.\n\n' +
      'Выберите что вас интересует:',
      Markup.keyboard([
        ['🩹 Уход за тату', '⚠️ Возможные проблемы'],
        ['🚫 Что нельзя делать', '⏱ Мои напоминания'],
        ['📊 Статус заживления', '❓ Задать вопрос'],
        ['📅 Запись']  // новая кнопка
      ]).resize()
    );
    return;
  }
  
  // Сохраняем вопрос в базу данных
  try {
    await ctx.db.User.updateOne(
      { telegramId: ctx.from.id },
      {
        $push: {
          questions: {
            question: userText,
            date: new Date(),
            status: 'pending'
          }
        },
        $set: { stage: 'main_menu' }
      }
    );
    
    await ctx.replyWithHTML(
      '✅ <b>Ваш вопрос сохранен!</b>\n\n' +
      '📝 <b>Ваш вопрос:</b>\n' +
      userText.substring(0, 500) + (userText.length > 500 ? '...' : '') + '\n\n' +
      '⏳ <b>Мы ответим вам в течение 24 часов в рабочее время.</b>\n\n' +
      '🕒 <b>Время работы поддержки:</b>\n' +
      'Пн-Пт: 10:00-19:00\n' +
      'Сб: 11:00-16:00\n' +
      'Вс: выходной\n\n' +
      '📧 <b>Для срочных вопросов:</b> @tattoo_support_bot\n\n' +
      'Теперь выберите что вас интересует:',
      Markup.keyboard([
        ['🩹 Уход за тату', '⚠️ Возможные проблемы'],
        ['🚫 Что нельзя делать', '⏱ Мои напоминания'],
        ['📊 Статус заживления', '❓ Задать вопрос'],
        ['📅 Запись']  // новая кнопка
      ]).resize()
    );
    
  } catch (error) {
    console.error('Ошибка при сохранении вопроса:', error);
    await ctx.reply(
      '❌ Произошла ошибка при сохранении вопроса. Попробуйте позже.',
      Markup.keyboard([
        ['🩹 Уход за тату', '⚠️ Возможные проблемы'],
        ['🚫 Что нельзя делать', '⏱ Мои напоминания'],
        ['📊 Статус заживления', '❓ Задать вопрос'],
        ['📅 Запись']  // новая кнопка
      ]).resize()
    );
  }
}

// ========== GRACEFUL SHUTDOWN ==========

const gracefulShutdown = async (signal) => {
  console.log(`\n🛑 Получен сигнал ${signal}. Остановка бота...`);
  
  try {
    // Останавливаем бота
    console.log('⏳ Останавливаю бота...');
    await bot.stop();
    console.log('✅ Бот остановлен');
    
    // Закрываем соединение с MongoDB
    if (mongoose && mongoose.connection && mongoose.connection.readyState === 1) {
      console.log('⏳ Закрываю соединение с MongoDB...');
      await mongoose.connection.close();
      console.log('✅ Соединение с MongoDB закрыто');
    }
    
    console.log('✅ Все соединения корректно закрыты');
    console.log('👋 Завершение работы');
    
  } catch (error) {
    console.error('❌ Ошибка при остановке:', error.message);
  } finally {
    // Для nodemon используем SIGTERM, для обычного запуска - exit
    if (process.env.NODEMON || signal === 'SIGUSR2') {
      console.log('🔄 Готово к перезапуску nodemon...');
      process.kill(process.pid, 'SIGTERM');
    } else {
      process.exit(0);
    }
  }
};

// ========== ОБРАБОТКА СИГНАЛОВ ==========

// Обычный Ctrl+C
process.once('SIGINT', () => gracefulShutdown('SIGINT'));

// Команда kill или systemd
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Специально для nodemon (перезагрузка)
process.once('SIGUSR2', () => gracefulShutdown('SIGUSR2'));

// ========== ОБРАБОТКА НЕПЕРЕХВАЧЕННЫХ ОШИБОК ==========

process.on('uncaughtException', (error) => {
  console.error('💥 Неперехваченная ошибка:', error.message);
  console.error('Стек ошибки:', error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Необработанный промис:', reason);
  console.error('Промис:', promise);
  // Не останавливаем бота при unhandledRejection
  // Это позволит боту продолжать работу даже если какая-то кнопка не обработана
});