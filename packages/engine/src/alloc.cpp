// Global operator new/delete without exceptions. Allocation happens only when objects are
// created, never on the audio path; a failed allocation aborts instead of throwing.
#include <cstdlib>
#include <new>

void* operator new(std::size_t n) { void* p = std::malloc(n ? n : 1); if (!p) std::abort(); return p; }
void* operator new[](std::size_t n) { return operator new(n); }
void* operator new(std::size_t n, const std::nothrow_t&) noexcept { return std::malloc(n ? n : 1); }
void* operator new[](std::size_t n, const std::nothrow_t&) noexcept { return std::malloc(n ? n : 1); }
void* operator new(std::size_t n, std::align_val_t a) {
  void* p = std::aligned_alloc((std::size_t)a, ((n + (std::size_t)a - 1) / (std::size_t)a) * (std::size_t)a);
  if (!p) std::abort();
  return p;
}
void* operator new[](std::size_t n, std::align_val_t a) { return operator new(n, a); }
void operator delete(void* p) noexcept { std::free(p); }
void operator delete[](void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }
void operator delete[](void* p, std::size_t) noexcept { std::free(p); }
void operator delete(void* p, std::align_val_t) noexcept { std::free(p); }
void operator delete[](void* p, std::align_val_t) noexcept { std::free(p); }
void operator delete(void* p, std::size_t, std::align_val_t) noexcept { std::free(p); }
void operator delete[](void* p, std::size_t, std::align_val_t) noexcept { std::free(p); }

#if defined(__wasm__)
// libc++ helpers (length_error, bad_alloc) reference these; with exceptions off they just abort.
extern "C" void* __cxa_allocate_exception(std::size_t) { std::abort(); }
extern "C" void __cxa_throw(void*, void*, void (*)(void*)) { std::abort(); }
#endif

#if defined(__wasm__)
extern "C" void __cxa_pure_virtual() { std::abort(); }
#endif
