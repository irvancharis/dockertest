import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/product.dart';
import '../services/api_service.dart';
import '../services/database_service.dart';

class SalesProvider with ChangeNotifier {
  String? _token;
  String? _depoName;
  String? _depoId;
  String? _loggedInUser;
  String? _userPosition;
  String _baseUrl = 'http://10.0.2.2:4000'; // Default for Android Emulator
  List<Product> _products = [];
  List<CartItem> _cart = [];
  bool _isLoading = false;

  String? get token => _token;
  String? get depoName => _depoName;
  String? get depoId => _depoId;
  String? get loggedInUser => _loggedInUser;
  String? get userPosition => _userPosition;
  List<Product> get products => _products;
  List<CartItem> get cart => _cart;
  bool get isLoading => _isLoading;
  double get totalAmount => _cart.fold(0, (sum, item) => sum + item.total);

  ApiService get _api => ApiService(_baseUrl);

  Future<void> init() async {
    final prefs = await SharedPreferences.getInstance();
    _token = prefs.getString('depo_token');
    _depoName = prefs.getString('depo_name');
    _depoId = prefs.getString('depo_id');
    _baseUrl = prefs.getString('server_url') ?? _baseUrl;
    _loggedInUser = prefs.getString('logged_in_user');
    _userPosition = prefs.getString('user_position');
    
    if (_token != null) {
      fetchProducts();
    }
  }

  Future<void> syncEmployees() async {
    if (_token == null) return;
    try {
      final employees = await _api.getEmployees(_token!);
      await DatabaseService().saveEmployees(employees);
    } catch (e) {
      print('Sync employees error: $e');
    }
  }

  Future<bool> login(String username, String password) async {
    final user = await DatabaseService().login(username, password);
    if (user != null) {
      _loggedInUser = user['name'];
      _userPosition = user['position'];
      
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('logged_in_user', _loggedInUser!);
      await prefs.setString('user_position', _userPosition!);
      
      notifyListeners();
      return true;
    }
    return false;
  }

  Future<void> activate(String token, String serverUrl) async {
    _isLoading = true;
    notifyListeners();
    try {
      _baseUrl = serverUrl;
      final data = await ApiService(serverUrl).checkToken(token);
      _token = token;
      _depoName = data['name'];
      _depoId = data['depo_id'];

      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('depo_token', token);
      await prefs.setString('depo_name', _depoName!);
      await prefs.setString('depo_id', _depoId!);
      await prefs.setString('server_url', serverUrl);

      await syncEmployees();
      await fetchProducts();
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  Future<void> fetchProducts() async {
    if (_token == null) return;
    _isLoading = true;
    notifyListeners();
    try {
      _products = await _api.getProducts(_token!);
    } catch (e) {
      print('Error fetching products: $e');
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  void addToCart(Product product) {
    final index = _cart.indexWhere((item) => item.product.id == product.id);
    if (index >= 0) {
      _cart[index].quantity++;
    } else {
      _cart.add(CartItem(product: product));
    }
    notifyListeners();
  }

  void removeFromCart(Product product) {
    _cart.removeWhere((item) => item.product.id == product.id);
    notifyListeners();
  }

  Future<bool> checkout() async {
    if (_token == null || _cart.isEmpty) return false;
    _isLoading = true;
    notifyListeners();
    try {
      final success = await _api.submitSale(_token!, _cart);
      if (success) {
        _cart.clear();
        return true;
      }
      return false;
    } catch (e) {
      return false;
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  void logout() async {
    _loggedInUser = null;
    _userPosition = null;
    _cart.clear();
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('logged_in_user');
    await prefs.remove('user_position');
    notifyListeners();
  }

  Future<void> resetActivation() async {
    _token = null;
    _depoName = null;
    _depoId = null;
    _loggedInUser = null;
    _userPosition = null;
    _cart.clear();
    final prefs = await SharedPreferences.getInstance();
    await prefs.clear();
    notifyListeners();
  }
}
