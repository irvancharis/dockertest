import 'package:sqflite/sqflite.dart';
import 'package:path/path.dart';

class DatabaseService {
  static final DatabaseService _instance = DatabaseService._internal();
  static Database? _database;

  factory DatabaseService() => _instance;

  DatabaseService._internal();

  Future<Database> get database async {
    if (_database != null) return _database!;
    _database = await _initDatabase();
    return _database!;
  }

  Future<Database> _initDatabase() async {
    String path = join(await getDatabasesPath(), 'depo_local.db');
    return await openDatabase(
      path,
      version: 1,
      onCreate: (db, version) async {
        await db.execute('''
          CREATE TABLE employees (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            username TEXT UNIQUE,
            password TEXT,
            position TEXT
          )
        ''');
      },
    );
  }

  Future<void> saveEmployees(List<dynamic> employees) async {
    final db = await database;
    await db.transaction((txn) async {
      await txn.delete('employees'); // Clear old data
      for (var e in employees) {
        await txn.insert('employees', {
          'name': e['name'],
          'username': e['username'],
          'password': e['password'],
          'position': e['position'],
        });
      }
    });
  }

  Future<Map<String, dynamic>?> login(String username, String password) async {
    final db = await database;
    final List<Map<String, dynamic>> maps = await db.query(
      'employees',
      where: 'username = ? AND password = ?',
      whereArgs: [username, password],
    );

    if (maps.isNotEmpty) {
      return maps.first;
    }
    return null;
  }
}
