import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'providers/sales_provider.dart';
import 'screens/activation_screen.dart';
import 'screens/login_screen.dart';
import 'screens/home_screen.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final salesProvider = SalesProvider();
  await salesProvider.init();

  runApp(
    MultiProvider(
      providers: [
        ChangeNotifierProvider.value(value: salesProvider),
      ],
      child: const MyApp(),
    ),
  );
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Sales Mobile Karyawan',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF6366F1),
          brightness: Brightness.dark,
        ),
        fontFamily: 'Outfit',
        cardTheme: CardThemeData(
          elevation: 0,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
          color: const Color(0xFF1E293B),
        ),

      ),
      home: Consumer<SalesProvider>(
        builder: (context, sales, _) {
          if (sales.token == null) return const ActivationScreen();
          if (sales.loggedInUser == null) return const LoginScreen();
          return const HomeScreen();
        },
      ),
    );
  }
}
