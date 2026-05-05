import 'dart:convert';
import 'package:http/http.dart' as http;
import '../models/product.dart';

class ApiService {
  final String baseUrl; // Example: http://192.168.1.100:4000

  ApiService(this.baseUrl);

  Future<Map<String, dynamic>> checkToken(String token) async {
    final response = await http.get(Uri.parse('$baseUrl/api/check-token?token=$token'));
    if (response.statusCode == 200) {
      return json.decode(response.body);
    } else {
      throw Exception('Token tidak valid atau server bermasalah');
    }
  }

  Future<List<Product>> getProducts(String token) async {
    final response = await http.get(
      Uri.parse('$baseUrl/api/products'),
      headers: {'X-Depo-Token': token},
    );
    if (response.statusCode == 200) {
      List data = json.decode(response.body);
      return data.map((json) => Product.fromJson(json)).toList();
    } else {
      throw Exception('Gagal memuat produk');
    }
  }

  Future<bool> submitSale(String token, List<CartItem> items) async {
    final double totalAmount = items.fold(0, (sum, item) => sum + item.total);
    final saleData = {
      'sales': [
        {
          'id': 'FLT-${DateTime.now().millisecondsSinceEpoch}',
          'total_amount': totalAmount,
          'sale_date': DateTime.now().toIso8601String(),
        }
      ]
    };

    final response = await http.post(
      Uri.parse('$baseUrl/api/receive-sync'),
      headers: {
        'Content-Type': 'application/json',
        'X-Depo-Token': token,
      },
      body: json.encode(saleData),
    );

    return response.statusCode == 200;
  }

  Future<List<dynamic>> getEmployees(String token) async {
    final response = await http.get(
      Uri.parse('$baseUrl/api/employees'),
      headers: {'X-Depo-Token': token},
    );
    if (response.statusCode == 200) {
      return json.decode(response.body);
    } else {
      throw Exception('Gagal memuat data karyawan');
    }
  }
}
