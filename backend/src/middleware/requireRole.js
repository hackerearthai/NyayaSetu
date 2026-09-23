/**
 * requireRole(...roles) - RBAC middleware factory.
 *
 * Usage:
 *   router.post('/demo-tamper', authMiddleware, requireRole('admin'), handler)
 *
 * Returns 403 if req.user.role is not in the allowed list.
 * Must be used after authMiddleware so req.user is populated.
 */
function requireRole(...roles) {
  return function roleGuard(req, res, next) {
    const userRole = req.user && req.user.role;

    if (!userRole || !roles.includes(userRole)) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Access requires role: ' + roles.join(', ') + '. Your role: ' + (userRole || 'none') + '.',
      });
    }

    next();
  };
}

module.exports = requireRole;
