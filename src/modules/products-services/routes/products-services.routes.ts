import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.js';
import { resolveTenantSchema } from '../../../middleware/tenantSchema.js';
import productController from '../controllers/product.controller.js';
import serviceController from '../controllers/service.controller.js';
import categoryController from '../controllers/category.controller.js';
import commonController from '../controllers/common.controller.js';

const router = Router();

router.use(requireAuth, resolveTenantSchema);

// Products
router.post('/product', productController.saveProduct);
router.get('/product', productController.findAllProduct);
router.get('/product/search', productController.searchProducts);
router.get('/product/:productId', productController.findOneProduct);
router.put('/product/:productId', productController.updateProduct);
router.delete('/product/:productId', productController.deleteProduct);

// Services
router.post('/service', serviceController.saveService);
router.get('/service', serviceController.findAllServices);
router.get('/service/search', serviceController.searchServices);
router.get('/service/:serviceId', serviceController.findOneService);
router.put('/service/:serviceId', serviceController.updateService);
router.delete('/service/:serviceId', serviceController.deleteService);

// Categories (classificazione di prodotti/servizi: vedi models/index.ts)
router.post('/category', categoryController.saveCategory);
router.get('/category', categoryController.findAllCategories);
router.get('/category/search', categoryController.searchCategories);
router.get('/category/:categoryId', categoryController.findOneCategory);
router.put('/category/:categoryId', categoryController.updateCategory);
router.delete('/category/:categoryId', categoryController.deleteCategory);

// Combined search
router.get('/product-service/search', commonController.searchServicesAndProducts);

export default router;

