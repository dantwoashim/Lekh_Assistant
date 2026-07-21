cmake_minimum_required(VERSION 3.20)
project(LekhTextService LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "LekhTextService is a Windows TSF DLL and must be built on Windows with MSVC.")
endif()

add_library(LekhTsfProtocol STATIC
  TsfProtocol.cpp
)

add_library(LekhCandidateState STATIC
  CandidateState.cpp
)

add_library(LekhWindowsIdentity STATIC
  LekhWindowsIdentity.cpp
)

add_library(LekhPipeServerIdentity STATIC
  LekhPipeServerIdentity.cpp
)

add_library(LekhPipeSecurity STATIC
  LekhPipeSecurity.cpp
)

add_library(LekhDaemonBackend STATIC
  LekhDaemonBackend.cpp
)

target_compile_features(LekhTsfProtocol PUBLIC cxx_std_20)
target_include_directories(LekhTsfProtocol PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_compile_features(LekhCandidateState PUBLIC cxx_std_20)
target_include_directories(LekhCandidateState PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_compile_features(LekhWindowsIdentity PUBLIC cxx_std_20)
target_compile_definitions(LekhWindowsIdentity PRIVATE
  UNICODE
  _UNICODE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  _WIN32_WINNT=0x0A00
)
target_include_directories(LekhWindowsIdentity PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(LekhWindowsIdentity PRIVATE advapi32)
target_compile_features(LekhPipeServerIdentity PUBLIC cxx_std_20)
target_compile_definitions(LekhPipeServerIdentity PRIVATE
  UNICODE
  _UNICODE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  _WIN32_WINNT=0x0A00
)
target_include_directories(LekhPipeServerIdentity PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(LekhPipeServerIdentity PRIVATE LekhWindowsIdentity)
target_compile_features(LekhPipeSecurity PUBLIC cxx_std_20)
target_compile_definitions(LekhPipeSecurity PRIVATE
  UNICODE
  _UNICODE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  _WIN32_WINNT=0x0A00
)
target_include_directories(LekhPipeSecurity PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(LekhPipeSecurity PRIVATE LekhWindowsIdentity advapi32)
target_compile_features(LekhDaemonBackend PUBLIC cxx_std_20)
target_compile_definitions(LekhDaemonBackend PRIVATE
  UNICODE
  _UNICODE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  _WIN32_WINNT=0x0A00
)
target_include_directories(LekhDaemonBackend PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(LekhDaemonBackend PRIVATE LekhPipeSecurity bcrypt)

add_library(LekhTextService SHARED
  CandidateWindow.cpp
  ClassFactory.cpp
  DllMain.cpp
  InputScopeGuids.cpp
  IpcClient.cpp
  LekhTextService.cpp
  LekhTextService.def
  Register.cpp
  TsfEditSession.cpp
)

target_compile_features(LekhTextService PRIVATE cxx_std_20)
target_compile_definitions(LekhTextService PRIVATE
  UNICODE
  _UNICODE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  _WIN32_WINNT=0x0A00
)
target_include_directories(LekhTextService PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(LekhTextService PRIVATE
  LekhCandidateState
  LekhTsfProtocol
  LekhPipeServerIdentity
  LekhWindowsIdentity
  ole32
  oleaut32
  uuid
  advapi32
  gdi32
  shlwapi
  user32
)

add_executable(LekhPipeBroker WIN32
  LekhPipeBroker.cpp
)

target_compile_features(LekhPipeBroker PRIVATE cxx_std_20)
target_compile_definitions(LekhPipeBroker PRIVATE
  UNICODE
  _UNICODE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  _WIN32_WINNT=0x0A00
)
target_include_directories(LekhPipeBroker PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(LekhPipeBroker PRIVATE
  LekhDaemonBackend
  LekhPipeSecurity
  LekhTsfProtocol
  LekhWindowsIdentity
)

if(MSVC)
  target_compile_options(LekhTsfProtocol PRIVATE /W4 /WX /permissive- /utf-8 /sdl)
  target_compile_options(LekhCandidateState PRIVATE /W4 /WX /permissive- /utf-8 /sdl)
  target_compile_options(LekhWindowsIdentity PRIVATE /W4 /WX /permissive- /utf-8 /sdl)
  target_compile_options(LekhPipeServerIdentity PRIVATE /W4 /WX /permissive- /utf-8 /sdl)
  target_compile_options(LekhPipeSecurity PRIVATE /W4 /WX /permissive- /utf-8 /sdl)
  target_compile_options(LekhDaemonBackend PRIVATE /W4 /WX /permissive- /utf-8 /sdl)
  target_compile_options(LekhTextService PRIVATE /W4 /WX /permissive- /utf-8 /sdl)
  target_compile_options(LekhPipeBroker PRIVATE /W4 /WX /permissive- /utf-8 /sdl)
endif()

set_target_properties(LekhTextService PROPERTIES
  OUTPUT_NAME "LekhTextService"
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
  LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
  ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/lib"
)

set_target_properties(LekhPipeBroker PROPERTIES
  OUTPUT_NAME "LekhPipeBroker"
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
)

include(CTest)
if(BUILD_TESTING)
  add_executable(LekhTsfProtocolTests TsfProtocolTests.cpp)
  target_link_libraries(LekhTsfProtocolTests PRIVATE LekhTsfProtocol)
  if(MSVC)
    target_compile_options(LekhTsfProtocolTests PRIVATE /W4 /WX /permissive- /utf-8 /sdl)
  endif()
  add_test(NAME LekhTsfProtocolTests COMMAND LekhTsfProtocolTests)

  add_executable(LekhCandidateStateTests CandidateStateTests.cpp)
  target_link_libraries(LekhCandidateStateTests PRIVATE LekhCandidateState)
  if(MSVC)
    target_compile_options(LekhCandidateStateTests PRIVATE /W4 /WX /permissive- /utf-8 /sdl)
  endif()
  add_test(NAME LekhCandidateStateTests COMMAND LekhCandidateStateTests)

  add_executable(LekhTsfInjectionTests
    InputScopeGuids.cpp
    TsfEditSession.cpp
    TsfInjectionTests.cpp
  )
  target_compile_features(LekhTsfInjectionTests PRIVATE cxx_std_20)
  target_compile_definitions(LekhTsfInjectionTests PRIVATE
    UNICODE
    _UNICODE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    _WIN32_WINNT=0x0A00
  )
  target_include_directories(LekhTsfInjectionTests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
  target_link_libraries(LekhTsfInjectionTests PRIVATE LekhCandidateState ole32 oleaut32 uuid)
  if(MSVC)
    target_compile_options(LekhTsfInjectionTests PRIVATE /W4 /WX /permissive- /utf-8 /sdl)
  endif()
  add_test(NAME LekhTsfInjectionTests COMMAND LekhTsfInjectionTests)

  add_executable(LekhPipeSecurityTests LekhPipeSecurityTests.cpp)
  target_compile_definitions(LekhPipeSecurityTests PRIVATE
    UNICODE
    _UNICODE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    _WIN32_WINNT=0x0A00
  )
  target_link_libraries(LekhPipeSecurityTests PRIVATE LekhPipeSecurity advapi32)
  if(MSVC)
    target_compile_options(LekhPipeSecurityTests PRIVATE /W4 /WX /permissive- /utf-8 /sdl)
  endif()
  add_test(NAME LekhPipeSecurityTests COMMAND LekhPipeSecurityTests)

  add_executable(LekhPipeServerIdentityTests LekhPipeServerIdentityTests.cpp)
  target_compile_definitions(LekhPipeServerIdentityTests PRIVATE
    UNICODE
    _UNICODE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    _WIN32_WINNT=0x0A00
  )
  target_link_libraries(LekhPipeServerIdentityTests PRIVATE LekhPipeServerIdentity)
  if(MSVC)
    target_compile_options(LekhPipeServerIdentityTests PRIVATE /W4 /WX /permissive- /utf-8 /sdl)
  endif()
  add_test(NAME LekhPipeServerIdentityTests COMMAND LekhPipeServerIdentityTests)

  add_executable(LekhDaemonBackendFixture LekhDaemonBackendFixture.cpp)
  target_compile_definitions(LekhDaemonBackendFixture PRIVATE
    UNICODE
    _UNICODE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    _WIN32_WINNT=0x0A00
  )
  if(MSVC)
    target_compile_options(LekhDaemonBackendFixture PRIVATE /W4 /WX /permissive- /utf-8 /sdl)
  endif()

  add_executable(LekhDaemonBackendTests LekhDaemonBackendTests.cpp)
  target_compile_definitions(LekhDaemonBackendTests PRIVATE
    UNICODE
    _UNICODE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    _WIN32_WINNT=0x0A00
  )
  target_link_libraries(LekhDaemonBackendTests PRIVATE LekhDaemonBackend)
  add_dependencies(LekhDaemonBackendTests LekhDaemonBackendFixture)
  if(MSVC)
    target_compile_options(LekhDaemonBackendTests PRIVATE /W4 /WX /permissive- /utf-8 /sdl)
  endif()
  add_test(NAME LekhDaemonBackendTests COMMAND LekhDaemonBackendTests)
endif()
