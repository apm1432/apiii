/*  auth.js – password-based multi-user localStorage namespacing
    Include this script at the TOP of <head> in every HTML page.
    It overrides localStorage so all keys are prefixed with the user's password hash.
    If no user is logged in, it redirects to the login page. */

(function () {
  const LOGIN_PAGE = (function() {
    // Figure out relative path to root login page
    const depth = (location.pathname.match(/\//g) || []).length - 1;
    // If we're in a subfolder like /geography/page.html, depth >= 2
    const pathParts = location.pathname.split('/').filter(Boolean);
    // Check if we're in a subdirectory (not root)
    if (pathParts.length > 1) {
      return '../login.html';
    }
    return 'login.html';
  })();

  const userKey = sessionStorage.getItem('mpsc_user_key');

  // If no user logged in and we're not on login page, redirect
  if (!userKey && !location.pathname.endsWith('login.html')) {
    location.replace(LOGIN_PAGE);
    return;
  }

  // If no user key yet (we're on login page), don't override anything
  if (!userKey) return;

  // Override localStorage methods to namespace by user
  const _getItem = localStorage.getItem.bind(localStorage);
  const _setItem = localStorage.setItem.bind(localStorage);
  const _removeItem = localStorage.removeItem.bind(localStorage);

  localStorage.getItem = function (key) {
    return _getItem(userKey + '::' + key);
  };

  localStorage.setItem = function (key, value) {
    return _setItem(userKey + '::' + key, value);
  };

  localStorage.removeItem = function (key) {
    return _removeItem(userKey + '::' + key);
  };
})();
