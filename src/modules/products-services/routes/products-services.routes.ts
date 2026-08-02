import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.js';
import { requirePermission } from '../../../middleware/rbac.js';
import { resolveTenantSchema } from '../../../middleware/tenantSchema.js';
import productController from '../controllers/product.controller.js';
import serviceController from '../controllers/service.controller.js';
import categoryController from '../controllers/category.controller.js';
import commonController from '../controllers/common.controller.js';

const router = Router();

router.use(requireAuth, resolveTenantSchema);

// Il listino è un dato di configurazione del tenant: in lettura serve a tutti (fatture,
// prescrizioni), in scrittura è riservato a chi lo amministra.
// Products
router.post('/product', requirePermission('product', 'create'), productController.saveProduct);
router.get('/product', requirePermission('product', 'read'), productController.findAllProduct);
router.get('/product/search', requirePermission('product', 'read'), productController.searchProducts);
router.get('/product/:productId', requirePermission('product', 'read'), productController.findOneProduct);
router.put('/product/:productId', requirePermission('product', 'update'), productController.updateProduct);
router.delete('/product/:productId', requirePermission('product', 'delete'), productController.deleteProduct);

// Services
router.post('/service', requirePermission('product', 'create'), serviceController.saveService);
router.get('/service', requirePermission('product', 'read'), serviceController.findAllServices);
router.get('/service/search', requirePermission('product', 'read'), serviceController.searchServices);
router.get('/service/:serviceId', requirePermission('product', 'read'), serviceController.findOneService);
router.put('/service/:serviceId', requirePermission('product', 'update'), serviceController.updateService);
router.delete('/service/:serviceId', requirePermission('product', 'delete'), serviceController.deleteService);

// Categories (classificazione di prodotti/servizi: vedi models/index.ts)
router.post('/category', requirePermission('product', 'create'), categoryController.saveCategory);
router.get('/category', requirePermission('product', 'read'), categoryController.findAllCategories);
router.get('/category/search', requirePermission('product', 'read'), categoryController.searchCategories);
router.get('/category/:categoryId', requirePermission('product', 'read'), categoryController.findOneCategory);
router.put('/category/:categoryId', requirePermission('product', 'update'), categoryController.updateCategory);
router.delete('/category/:categoryId', requirePermission('product', 'delete'), categoryController.deleteCategory);

// Combined search
router.get('/product-service/search', requirePermission('product', 'read'), commonController.searchServicesAndProducts);

export default router;

