import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:intl/intl.dart';
import '../providers/sales_provider.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  bool _dialogShown = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _checkUpdate();
    });
  }

  void _checkUpdate() {
    final sales = Provider.of<SalesProvider>(context, listen: false);
    if (sales.updateInfo != null && !_dialogShown) {
      _showUpdateDialog(sales.updateInfo!);
      _dialogShown = true;
    }
  }

  void _showUpdateDialog(Map<String, dynamic> info) {
    final isForce = info['is_force_update'] == 1 || info['is_force_update'] == true;
    
    showDialog(
      context: context,
      barrierDismissible: !isForce,
      builder: (context) => AlertDialog(
        backgroundColor: const Color(0xFF1E293B),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
        title: Row(
          children: [
            const Icon(Icons.system_update, color: Color(0xFF6366F1)),
            const SizedBox(width: 12),
            const Text('Update Tersedia'),
          ],
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Versi baru ${info['version_name']} telah dirilis.', style: const TextStyle(fontWeight: FontWeight.bold)),
            const SizedBox(height: 12),
            const Text('Apa yang baru:', style: TextStyle(fontSize: 12, color: Colors.grey)),
            Text(info['release_notes'] ?? 'Peningkatan performa dan perbaikan bug.'),
            if (isForce) ...[
              const SizedBox(height: 16),
              const Text('Update ini wajib dilakukan untuk melanjutkan penggunaan aplikasi.', style: TextStyle(color: Colors.redAccent, fontSize: 12)),
            ]
          ],
        ),
        actions: [
          if (!isForce)
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('NANTI', style: TextStyle(color: Colors.grey)),
            ),
          ElevatedButton(
            onPressed: () {
              // In real app, launch URL to download APK
              ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Mengunduh update...')));
              if (!isForce) Navigator.pop(context);
            },
            style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFF6366F1),
              foregroundColor: Colors.white,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            ),
            child: const Text('UPDATE SEKARANG'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final sales = Provider.of<SalesProvider>(context);
    final currencyFormat = NumberFormat.currency(locale: 'id', symbol: 'Rp ', decimalDigits: 0);

    // Re-check update if state changes (e.g. after sync)
    if (sales.updateInfo != null && !_dialogShown) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _checkUpdate());
    }

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('${sales.depoName} | ${sales.loggedInUser}', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
            Text('${sales.depoId} | ${sales.userPosition}', style: const TextStyle(fontSize: 12, color: Colors.grey)),
          ],
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout),
            onPressed: () => sales.logout(),
          )
        ],
      ),
      body: sales.isLoading && sales.products.isEmpty
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: () => sales.fetchProducts(),
              child: GridView.builder(
                padding: const EdgeInsets.all(16),
                gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: 2,
                  childAspectRatio: 0.75,
                  crossAxisSpacing: 16,
                  mainAxisSpacing: 16,
                ),
                itemCount: sales.products.length,
                itemBuilder: (context, index) {
                  final product = sales.products[index];
                  return Card(
                    child: Padding(
                      padding: const EdgeInsets.all(12),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Expanded(
                            child: Container(
                              width: double.infinity,
                              decoration: BoxDecoration(
                                color: Colors.white10,
                                borderRadius: BorderRadius.circular(12),
                              ),
                              child: const Icon(Icons.inventory_2, size: 40, color: Colors.white24),
                            ),
                          ),
                          const SizedBox(height: 12),
                          Text(product.name, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.bold)),
                          const SizedBox(height: 4),
                          Text(currencyFormat.format(product.price), style: TextStyle(color: Theme.of(context).colorScheme.primary, fontWeight: FontWeight.bold)),
                          const SizedBox(height: 8),
                          SizedBox(
                            width: double.infinity,
                            child: ElevatedButton(
                              onPressed: () => sales.addToCart(product),
                              style: ElevatedButton.styleFrom(
                                backgroundColor: Theme.of(context).colorScheme.primary,
                                foregroundColor: Colors.white,
                                padding: EdgeInsets.zero,
                                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                              ),
                              child: const Text('TAMBAH'),
                            ),
                          )
                        ],
                      ),
                    ),
                  );
                },
              ),
            ),
      floatingActionButton: sales.cart.isEmpty
          ? null
          : FloatingActionButton.extended(
              onPressed: () => _showCart(context),
              label: Text('KERANJANG (${sales.cart.length})'),
              icon: const Icon(Icons.shopping_cart),
            ),
    );
  }

  void _showCart(BuildContext context) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (context) => const CartSheet(),
    );
  }
}

class CartSheet extends StatelessWidget {
  const CartSheet({super.key});

  @override
  Widget build(BuildContext context) {
    final sales = Provider.of<SalesProvider>(context);
    final currencyFormat = NumberFormat.currency(locale: 'id', symbol: 'Rp ', decimalDigits: 0);

    return Container(
      height: MediaQuery.of(context).size.height * 0.7,
      decoration: const BoxDecoration(
        color: Color(0xFF1E293B),
        borderRadius: BorderRadius.vertical(top: Radius.circular(30)),
      ),
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text('Ringkasan Pesanan', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
              IconButton(onPressed: () => Navigator.pop(context), icon: const Icon(Icons.close)),
            ],
          ),
          const Divider(height: 32),
          Expanded(
            child: ListView.builder(
              itemCount: sales.cart.length,
              itemBuilder: (context, index) {
                final item = sales.cart[index];
                return ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text(item.product.name),
                  subtitle: Text('${item.quantity} x ${currencyFormat.format(item.product.price)}'),
                  trailing: Text(currencyFormat.format(item.total), style: const TextStyle(fontWeight: FontWeight.bold)),
                );
              },
            ),
          ),
          const Divider(height: 32),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text('Total Pembayaran', style: TextStyle(fontSize: 16)),
              Text(currencyFormat.format(sales.totalAmount), style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
            ],
          ),
          const SizedBox(height: 24),
          SizedBox(
            width: double.infinity,
            height: 60,
            child: ElevatedButton(
              onPressed: sales.isLoading
                  ? null
                  : () async {
                      final success = await sales.checkout();
                      if (success) {
                        Navigator.pop(context);
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(content: Text('Transaksi Berhasil!'), backgroundColor: Colors.green),
                        );
                      } else {
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(content: Text('Gagal mengirim transaksi'), backgroundColor: Colors.red),
                        );
                      }
                    },
              style: ElevatedButton.styleFrom(
                backgroundColor: Colors.green,
                foregroundColor: Colors.white,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
              ),
              child: sales.isLoading
                  ? const CircularProgressIndicator(color: Colors.white)
                  : const Text('KONFIRMASI PENJUALAN', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
            ),
          ),
        ],
      ),
    );
  }
}
